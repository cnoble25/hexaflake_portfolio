#!/usr/bin/env bash
# Deploy the hexaflake site to the existing portfolio hosting:
#   Browser -> CloudFront (https://d2y6keds9t037f.cloudfront.net) -> private S3 bucket
# This replaces the old terminal frontend in the same bucket. Needs the AWS CLI, signed in.
#
#   ./scripts/deploy.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BUCKET="${FRONTEND_S3_BUCKET:-carson-portfolio-frontend-115439078550}"
DISTRIBUTION_ID="${FRONTEND_CLOUDFRONT_DISTRIBUTION_ID:-E1RRWERRAXBXDL}"
DISTRIBUTION_DOMAIN="${FRONTEND_CLOUDFRONT_DOMAIN:-d2y6keds9t037f.cloudfront.net}"

python3 scripts/build_dist.py

# Hashed assets can be cached for a year; everything else revalidates often.
aws s3 sync dist/assets/ "s3://${BUCKET}/assets/" \
  --cache-control "public,max-age=31536000,immutable"
aws s3 sync dist/images/ "s3://${BUCKET}/images/" \
  --cache-control "public,max-age=604800"
aws s3 cp dist/favicon.svg "s3://${BUCKET}/favicon.svg" \
  --cache-control "public,max-age=86400" --content-type "image/svg+xml"
aws s3 cp dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "public,max-age=60" --content-type "text/html"
# Only after the new files are in place, remove what the new site doesn't use (the old
# terminal site's files). --size-only skips re-uploading what was just copied above.
aws s3 sync dist/ "s3://${BUCKET}/" --delete --size-only

INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" --paths "/*" \
  --query 'Invalidation.Id' --output text)
echo "Invalidating CloudFront (${INVALIDATION_ID})..."
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION_ID" --id "$INVALIDATION_ID"
echo "Deployed: https://${DISTRIBUTION_DOMAIN}"
