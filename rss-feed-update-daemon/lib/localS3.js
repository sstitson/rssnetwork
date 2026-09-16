'use strict';

// Drop-in stand-in for lib/s3.js that reads/writes JSON on local disk
// instead of S3. Used only by local-test.js so the Lambda logic can be
// exercised without AWS credentials. Not used in the deployed function.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'local-s3-data');

function keyToPath(bucket, key) {
  return path.join(ROOT, bucket, key);
}

async function getJson(bucket, key, fallback = null) {
  const filePath = keyToPath(bucket, key);
  if (!fs.existsSync(filePath)) return fallback;
  const text = fs.readFileSync(filePath, 'utf-8');
  if (!text.trim()) return fallback;
  return JSON.parse(text);
}

async function putJson(bucket, key, value) {
  const filePath = keyToPath(bucket, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

module.exports = { getJson, putJson };
