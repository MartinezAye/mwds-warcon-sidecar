import { z } from "zod";
import { limits } from "./limits.js";
import { agentName } from "./version.js";

export const steamIdPattern = /^7656119\d{10}$/;

export const counterMin = -1_000_000;
export const counterMax = 10_000_000;
export const cashLimit = 1_000_000_000_000;
export const pingLimit = 1_000_000;
export const scoreLimit = 1_000_000_000;
export const playersMaxLimit = 1024;

const counter = z.number().int().min(counterMin).max(counterMax).nullable();

export const samplePlayerSchema = z
  .object({
    steamId: z.string().max(17).regex(steamIdPattern),
    name: z.string().max(256),
    faction: z.string().max(256).nullable(),
    kills: counter,
    deaths: counter,
    cash: z.number().int().min(-cashLimit).max(cashLimit).nullable(),
    pingMs: z.number().int().min(-pingLimit).max(pingLimit).nullable(),
  })
  .strict();

export const sampleFactionScoreSchema = z
  .object({
    name: z.string().min(1).max(256),
    colorHex: z.string().max(16).nullable(),
    score: z.number().min(-scoreLimit).max(scoreLimit).nullable(),
  })
  .strict();

export const sampleSchema = z
  .object({
    at: z.iso.datetime({ offset: true }).max(40),
    serverName: z.string().max(512).nullable(),
    map: z.string().max(256).nullable(),
    playersMax: z.number().int().min(0).max(playersMaxLimit).nullable(),
    factionScores: z.array(sampleFactionScoreSchema).max(limits.factionsPerSample),
    players: z.array(samplePlayerSchema).max(limits.playersPerSample),
  })
  .strict();

export const samplesBodySchema = z
  .object({
    source: z.literal("warcon"),
    agent: z
      .object({
        name: z.literal(agentName),
        version: z.string().min(1).max(32),
      })
      .strict(),
    samples: z.array(sampleSchema).min(1).max(limits.samplesPerPost),
  })
  .strict();

export const samplesResponseSchema = z
  .object({
    ok: z.literal(true),
    accepted: z.number().int().min(0),
    skipped: z.number().int().min(0),
    latestPluginVersion: z.string().max(32).nullable(),
  })
  .strict();

export const ingestErrorBodySchema = z
  .object({
    error: z.object({ code: z.string().max(64) }).strict(),
  })
  .strict();

export type Sample = z.infer<typeof sampleSchema>;
export type SamplePlayer = z.infer<typeof samplePlayerSchema>;
export type SampleFactionScore = z.infer<typeof sampleFactionScoreSchema>;
export type SamplesBody = z.infer<typeof samplesBodySchema>;
