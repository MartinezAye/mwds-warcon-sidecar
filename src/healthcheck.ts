import { isHealthy } from "./heartbeat.js";

const dir = process.env.SPOOL_DIR?.trim();
process.exitCode = isHealthy(dir === undefined || dir === "" ? "/data" : dir, Date.now()) ? 0 : 1;
