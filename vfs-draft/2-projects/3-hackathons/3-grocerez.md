# GrocerEZ

*HackMidwest, Oct 2026, team of 3*

A shared grocery app for households. The shopping list is what everyone in the house wants minus what's already in the pantry, with allergen warnings and recall alerts. An AI pantry agent plans the week's meals from 7,455 embedded recipes.

### My part
I was the top committer (90 of 220 commits) and built most of the backend:
* The database layer: Postgres and pgvector migrations, fuzzy item matching and concurrency fixes.
* The Express API: auth, household groups, the list engine, realtime updates and recalls.
* Semantic search and embeddings on Akamai, plus AI product lookup and price estimates.
* The app's feature screens, the Linode deployment, and merging the 3D pantry and agent work.

### Tech
* Expo, React Native
* Express, Prisma
* Postgres, pgvector
* Socket.IO
* AWS Strands Agents
* Docker, Caddy

- [Live demo](https://172-236-106-190.ip.linodeusercontent.com)
- [Source code](https://github.com/willcoyne/grocerez)
