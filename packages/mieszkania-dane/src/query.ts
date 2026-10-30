// Punkt wejścia dla serwisu: jeden model na cały proces budowy.
import { existsSync } from 'node:fs';
import { Model } from './analytics.ts';
import { dbPath, openDb } from './db.ts';

let model: Model | null = null;

export function getModel(): Model {
  if (model) return model;
  const path = dbPath();
  if (!existsSync(path)) throw new Error(`Brak bazy ${path}. Uruchom import albo "npm run mieszkania:sample".`);
  const db = openDb(path, { readonly: true });
  model = new Model(db);
  db.close();
  return model;
}

export * from './analytics.ts';
export * from './places.ts';
