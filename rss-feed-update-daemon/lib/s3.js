'use strict';

const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const s3 = new S3Client({});

/**
 * Buffer a Node.js/web ReadableStream body into a string.
 */
async function streamToString(body) {
  if (!body) return '';
  // AWS SDK v3 body has a helper on Node.js runtimes
  if (typeof body.transformToString === 'function') {
    return body.transformToString('utf-8');
  }
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Fetch and JSON.parse an S3 object. Returns `fallback` if the key
 * doesn't exist yet (first run for a feed) or the object is empty/invalid.
 */
async function getJson(bucket, key, fallback = null) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await streamToString(res.Body);
    if (!text || !text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return fallback;
    }
    throw err;
  }
}

/**
 * Write a JS value to S3 as pretty-printed JSON.
 */
async function putJson(bucket, key, value) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: 'application/json',
    })
  );
}

module.exports = { getJson, putJson };
