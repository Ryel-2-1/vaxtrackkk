"use strict";

// Sends one unauthenticated request carrying NO App Check token to a callable
// and prints the JSON response body, so a test can tell which layer refused it:
// the SDK's App Check gate ("Unauthenticated") or our own handler ("Please sign
// in and try again."). Run in a child process so ENFORCE_APP_CHECK is read
// fresh, exactly as it is at deploy/runtime.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-vaxtrack-appcheck";

const path = require("node:path");
const fns = require(path.join(__dirname, "..", "..", "index.js"));

const req = {
  method: "POST",
  headers: { "content-type": "application/json" },
  header(name) {
    return this.headers[name.toLowerCase()];
  },
  get(name) {
    return this.header(name);
  },
  body: { data: {} },
};
const res = {
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  set() {
    return this;
  },
  setHeader() {},
  getHeader() {},
  on() {},
  end() {},
  send(body) {
    process.stdout.write(`${JSON.stringify({ status: this.statusCode, body })}\n`);
  },
};
res.json = res.send;

fns[process.argv[2]](req, res);
