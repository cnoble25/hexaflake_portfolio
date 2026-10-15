# MangaFinder

*Solo project*

Semantic search for manga: describe a plot in your own words and it finds titles with similar stories.

### What I built
* A FastAPI backend that has an LLM (through Groq) rewrite your description as a synopsis, then ranks titles by cosine similarity between sentence-transformer embeddings.
* Filter, database search and "more like this title" endpoints.
* Scripts to embed and enrich the manga dataset.
* A React and TypeScript frontend.

### Tech
* Python, FastAPI
* Groq
* sentence-transformers
* React, TypeScript, Vite
* Docker Compose

- [Source code](https://github.com/cnoble25/MangaFinder)
