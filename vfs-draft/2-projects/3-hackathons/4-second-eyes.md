# Second Eyes

*DevFest 2026, team of 3*

An AI clinical assistant that acts as a second set of eyes: upload patient charts, PDFs or medical images, and it flags risks and missing orders and suggests differential diagnoses.

### My part
I built most of the backend AI pipeline:
* An orchestrator agent using Vertex AI function calling.
* A radiology vision step for medical images (LLaVA-Med, later Gemini vision).
* Merging multiple uploaded PDFs, plus retries, file-type handling and JSON repair for reliable model output.
* A combined extract-and-orchestrate call to cut response time, and the Docker Compose and nginx setup.

### Tech
* Vertex AI, Gemini
* Document AI
* Node, React, Vite
* Docker

- [Source code](https://github.com/heidischultz/devfest-26)
