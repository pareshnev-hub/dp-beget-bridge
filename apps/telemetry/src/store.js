import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function increment(object, key) {
  object[key] = (object[key] || 0) + 1;
}

export class AggregateStore {
  constructor({ dataDir, hashSecret, retentionDays }) {
    this.dataDir = dataDir;
    this.hashSecret = hashSecret;
    this.retentionDays = retentionDays;
    this.queue = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await this.removeExpired();
  }

  installationHash(id) {
    return crypto.createHmac("sha256", this.hashSecret).update(id).digest("hex");
  }

  record(event) {
    this.queue = this.queue.then(() => this.recordNow(event));
    return this.queue;
  }

  async recordNow(event) {
    const day = event.occurredAt.slice(0, 10);
    const destination = path.join(this.dataDir, `${day}.json`);
    let aggregate;
    try {
      aggregate = JSON.parse(await fs.readFile(destination, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      aggregate = {
        schemaVersion: 1,
        day,
        events: {},
        uniqueInstallations: [],
        durationBuckets: {},
        transferBuckets: {},
        versions: {},
      };
    }
    increment(aggregate.events, event.event);
    const installation = this.installationHash(event.installationId);
    if (!aggregate.uniqueInstallations.includes(installation)) aggregate.uniqueInstallations.push(installation);
    if (event.durationBucket) increment(aggregate.durationBuckets, event.durationBucket);
    if (event.sizeBucket) increment(aggregate.transferBuckets, `${event.direction}:${event.sizeBucket}`);
    if (event.version) increment(aggregate.versions, event.version);
    const temporary = `${destination}.part-${process.pid}`;
    await fs.writeFile(temporary, `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
    return aggregate;
  }

  async removeExpired() {
    const oldest = Date.now() - this.retentionDays * 86400000;
    for (const name of await fs.readdir(this.dataDir)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      if (match && new Date(`${match[1]}T00:00:00Z`).getTime() < oldest) {
        await fs.rm(path.join(this.dataDir, name), { force: true });
      }
    }
  }
}
