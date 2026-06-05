import 'dotenv/config';
import { DefaultAzureCredential } from '@azure/identity';
import express from 'express';
import Parser from 'rss-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const rssParser = new Parser();
const azureCredential = new DefaultAzureCredential();

const port = Number(process.env.PORT || 3210);
const azureResource = process.env.AZURE_OPENAI_RESOURCE || '';
const realtimeDeployment = process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || 'gpt-realtime-2';
const realtimeVoice = process.env.AZURE_OPENAI_REALTIME_VOICE || 'alloy';
const assistantPrompt =
  process.env.ASSISTANT_SYSTEM_PROMPT ||
  'You are a professional multilingual realtime assistant. Keep answers concise, grounded in tool results, and mention sources when available.';
const appTitle = process.env.APP_TITLE || 'Voice_Agent_Realtime';
const newsApiKey = process.env.NEWS_API_KEY || '';
const newsApiBaseUrl = process.env.NEWS_API_BASE_URL || 'https://gnews.io/api/v4';
const tavilyApiKey = process.env.TAVILY_API_KEY || '';
const defaultFetchTimeoutMs = 12000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    appTitle,
    azureConfigured: Boolean(azureResource && realtimeDeployment),
    authMode: 'DefaultAzureCredential',
    tools: ['weather_lookup', 'news_lookup', 'game_guide_lookup']
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    appTitle,
    azureConfigured: Boolean(azureResource && realtimeDeployment),
    realtime: {
      deployment: realtimeDeployment,
      voice: realtimeVoice,
      resource: azureResource ? `${azureResource}.openai.azure.com` : ''
    },
    authMode: 'DefaultAzureCredential'
  });
});

app.get('/api/realtime/token', asyncHandler(async (_req, res) => {
  if (!azureResource || !realtimeDeployment) {
    res.status(500).json({
      error: 'Azure OpenAI Realtime is not configured. Set AZURE_OPENAI_RESOURCE and AZURE_OPENAI_REALTIME_DEPLOYMENT.'
    });
    return;
  }

  const token = await azureCredential.getToken('https://ai.azure.com/.default');
  if (!token?.token) {
    res.status(500).json({
      error: 'Failed to acquire Azure AD token with DefaultAzureCredential.'
    });
    return;
  }

  const response = await fetchWithTimeout(`https://${azureResource}.openai.azure.com/openai/v1/realtime/client_secrets`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      session: {
        type: 'realtime',
        model: realtimeDeployment,
        instructions: assistantPrompt,
        audio: {
          output: {
            voice: realtimeVoice
          }
        }
      }
    })
  });

  const body = await response.text();
  if (!response.ok) {
    res.status(response.status).json({
      error: 'Failed to create Azure realtime client secret.',
      details: safeJson(body)
    });
    return;
  }

  const parsed = safeJson(body);
  res.json({
    token: parsed.value,
    expiresAt: parsed.expires_at || null,
    websocketUrl: `https://${azureResource}.openai.azure.com/openai/v1/realtime/calls?webrtcfilter=on`
  });
}));

app.post('/api/tools/weather', asyncHandler(async (req, res) => {
  const city = sanitizeText(req.body.city) || sanitizeText(req.body.location);
  if (!city) {
    res.status(400).json({ error: 'city is required' });
    return;
  }

  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.searchParams.set('name', city);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'zh');
  geoUrl.searchParams.set('format', 'json');

  const geoResponse = await fetchWithTimeout(geoUrl);
  const geo = await geoResponse.json();
  const place = geo.results?.[0];
  if (!place) {
    res.status(404).json({ error: `No location found for ${city}` });
    return;
  }

  const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
  weatherUrl.searchParams.set('latitude', String(place.latitude));
  weatherUrl.searchParams.set('longitude', String(place.longitude));
  weatherUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m');
  weatherUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  weatherUrl.searchParams.set('timezone', 'auto');

  const weatherResponse = await fetchWithTimeout(weatherUrl);
  const weather = await weatherResponse.json();
  const current = weather.current || {};
  const daily = weather.daily || {};

  res.json({
    type: 'weather',
    city: `${place.name}${place.country ? `, ${place.country}` : ''}`,
    latitude: place.latitude,
    longitude: place.longitude,
    summary: weatherCodeToText(current.weather_code),
    current: {
      temperatureC: current.temperature_2m,
      apparentTemperatureC: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      windSpeedKmh: current.wind_speed_10m
    },
    today: {
      maxTemperatureC: daily.temperature_2m_max?.[0] ?? null,
      minTemperatureC: daily.temperature_2m_min?.[0] ?? null,
      precipitationProbabilityMax: daily.precipitation_probability_max?.[0] ?? null,
      weatherCode: daily.weather_code?.[0] ?? null,
      summary: weatherCodeToText(daily.weather_code?.[0] ?? current.weather_code)
    },
    source: 'Open-Meteo'
  });
}));

app.post('/api/tools/news', asyncHandler(async (req, res) => {
  const topic = sanitizeText(req.body.topic) || 'technology';
  const limit = clamp(req.body.limit, 1, 8, 5);

  if (newsApiKey) {
    const url = new URL(`${newsApiBaseUrl.replace(/\/$/, '')}/search`);
    url.searchParams.set('q', topic);
    url.searchParams.set('lang', 'en');
    url.searchParams.set('max', String(limit));
    url.searchParams.set('apikey', newsApiKey);
    const response = await fetchWithTimeout(url);
    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: 'Failed to fetch news', details: data });
      return;
    }
    res.json({
      type: 'news',
      topic,
      items: (data.articles || []).map((item) => ({
        title: item.title,
        snippet: item.description,
        url: item.url,
        source: item.source?.name || 'GNews',
        publishedAt: item.publishedAt
      })),
      source: 'GNews'
    });
    return;
  }

  const url = new URL('https://hn.algolia.com/api/v1/search');
  url.searchParams.set('query', topic);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('hitsPerPage', String(limit));
  const response = await fetchWithTimeout(url);
  const data = await response.json();
  res.json({
    type: 'news',
    topic,
    items: (data.hits || []).slice(0, limit).map((item) => ({
      title: item.title,
      snippet: item.story_text || item.comment_text || item._highlightResult?.story_text?.value || item.title,
      url: item.url || `https://news.ycombinator.com/item?id=${item.objectID}`,
      source: item.author || 'Hacker News',
      publishedAt: item.created_at || null
    })),
    source: 'Hacker News Search'
  });
}));

app.post('/api/tools/game-guide', asyncHandler(async (req, res) => {
  const game = sanitizeText(req.body.game);
  const topic = sanitizeText(req.body.topic || req.body.question);
  const limit = clamp(req.body.limit, 1, 8, 5);
  if (!game && !topic) {
    res.status(400).json({ error: 'game or topic is required' });
    return;
  }

  const query = [game, topic, 'guide tips walkthrough build'].filter(Boolean).join(' ');

  if (tavilyApiKey) {
    const response = await fetchWithTimeout('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query,
        topic: 'general',
        search_depth: 'advanced',
        max_results: limit
      })
    });
    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: 'Failed to search guides', details: data });
      return;
    }
    res.json({
      type: 'game-guide',
      query,
      items: (data.results || []).map((item) => ({
        title: item.title,
        snippet: item.content,
        url: item.url,
        source: hostFromUrl(item.url)
      })),
      source: 'Tavily'
    });
    return;
  }

  const feed = await rssParser.parseURL(buildBingSearchRssUrl(query));
  const items = (feed.items || []).slice(0, limit).map((item) => ({
    title: item.title,
    snippet: item.contentSnippet || item.content || item.title,
    url: item.link,
    source: extractSourceName(item)
  }));

  res.json({
    type: 'game-guide',
    query,
    items,
    source: 'Bing Search RSS'
  });
}));

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(502).json({
    error: error.message || 'Unexpected server error'
  });
});

app.listen(port, () => {
  console.log(`${appTitle} running at http://127.0.0.1:${port}`);
});

function sanitizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function fetchWithTimeout(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(defaultFetchTimeoutMs)
  });
}

function safeJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown';
  }
}

function buildBingSearchRssUrl(query) {
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
}

function extractSourceName(item) {
  if (item.creator) {
    return item.creator;
  }
  if (item.source?.title) {
    return item.source.title;
  }
  return item.title?.split(' - ').at(-1) || 'Bing';
}

function weatherCodeToText(code) {
  const map = {
    0: '晴朗',
    1: '大致晴朗',
    2: '局部多云',
    3: '阴天',
    45: '有雾',
    48: '霜雾',
    51: '小毛雨',
    53: '毛雨',
    55: '大毛雨',
    61: '小雨',
    63: '降雨',
    65: '大雨',
    71: '小雪',
    73: '降雪',
    75: '大雪',
    80: '阵雨',
    81: '较强阵雨',
    82: '强阵雨',
    95: '雷暴',
    96: '雷暴伴小冰雹',
    99: '雷暴伴冰雹'
  };
  return map[code] || '天气信息暂不可用';
}
