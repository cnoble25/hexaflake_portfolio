# Jarvis

*Solo project, Jun 2026 – present*

A voice-first Linux desktop assistant. Hold a hotkey, speak, and it turns the request into terminal commands and desktop actions: timers, focus profiles, media and volume control, app launching and custom macros.

### What I built
* **Learned fast path:** a self-maintaining command cache distills each interaction into keyword patterns with slot extraction, so matched requests resolve locally in about 5 ms instead of about 3 s of model inference (roughly 600× faster). Rules that misfire on repeated use retire themselves.
* **Agent loop:** a ReAct-style orchestrator with schema-validated tools, 10+ desktop macro tools and custom tool manifests.
* **Local voice pipeline:** global hold-to-talk through Linux evdev on Wayland and X11, Faster-Whisper speech-to-text and Kokoro-ONNX speech synthesis.
* **Pluggable models:** Claude Haiku 4.5 or Sonnet, Gemini, or a fully local Ollama model (the default).

### Tech
* Python
* PySide6 (Qt 6)
* Faster-Whisper
* Kokoro-ONNX
* Anthropic API
* Ollama

- [Source code](https://github.com/cnoble25/Jarvis)
