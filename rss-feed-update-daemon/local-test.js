'use strict';

// Exercises the Lambda handler against local disk instead of real S3, so
// you can sanity-check the logic before deploying. Run it twice in a row
// to see the second run only append genuinely new items.
//
// Usage: node local-test.js
//
// Seeds local-s3-data/test-bucket/feeds.json from feeds.example.json on
// first run, then invokes the handler exactly as Lambda would.

const fs = require('fs');
const path = require('path');

// Swap lib/s3.js for the local-disk stand-in *before* anything else
// requires it, by pre-populating Node's module cache.
const s3ModulePath = require.resolve('./lib/s3');
require.cache[s3ModulePath] = {
  id: s3ModulePath,
  filename: s3ModulePath,
  loaded: true,
  exports: require('./lib/localS3'),
};

const BUCKET = 'test-bucket';
const dataDir = path.join(__dirname, 'local-s3-data', BUCKET);
const feedsPath = path.join(dataDir, 'feeds.json');

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(feedsPath)) {
  fs.copyFileSync(path.join(__dirname, 'feeds.example.json'), feedsPath);
  console.log(`Seeded ${feedsPath} from feeds.example.json`);
}

process.env.BUCKET_NAME = BUCKET;

const { handler } = require('./index');

handler({}, {})
  .then((summary) => {
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `\nOutput files written under local-s3-data/${BUCKET}/feeds/. Run again to see new-item detection in action.`
    );
  })
  .catch((err) => {
    console.error('Handler threw:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // rss-parser's HTTP client can leave keep-alive sockets open; this is
    // a local CLI test script (not the deployed Lambda), so it's safe to
    // force-exit once we've printed the result instead of waiting on them.
    process.exit(process.exitCode || 0);
  });
