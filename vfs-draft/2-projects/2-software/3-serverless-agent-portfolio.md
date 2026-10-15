# Serverless Agent Portfolio

*Solo project, Jul – Aug 2026*

The previous version of this site: a terminal-style portfolio with an AI co-pilot that drives the interface for you. Its virtual file system is the one this site reads today.

### What I built
* A React terminal frontend on S3 and CloudFront, with a Lambda backend on AWS Bedrock.
* Retrieval over an S3-hosted virtual file system, so the agent can generate tool calls (cd, cat, theme) that control the UI.
* A 100-task evaluation suite; task-completion accuracy went from 30% to 85%.
* A Google sign-in admin portal for editing the file system, with all AWS infrastructure defined in Terraform.

### Tech
* React, Vite
* AWS Lambda, API Gateway
* S3, CloudFront
* AWS Bedrock
* Terraform
