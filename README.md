# Meeting Assistant

This project is a meeting assistant application built with Streamlit, utilizing Azure Speech Fast Transcription and OpenAI's GPT-4 model to perform audio transcription, image analysis, and meeting summarization.

## File Structure

- `meeting_sum.py`: The main application file responsible for building the user interface and handling user interactions.
- `llm_analysis.py`: Contains functions to call the OpenAI GPT-4 API for image and text analysis.
- `speech_fast_transcription.py`: Contains functions to call the Azure Speech service for audio transcription.

## Installation

1. Clone this repository to your local machine:

   ```bash
   git clone https://github.com/yourusername/meeting-summary.git
   cd meeting-summary
