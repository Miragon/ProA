/**
 * Version of the fact format. Stored with every revision
 * (`model_revision.facts_version`) and part of `factsHash`; bump it whenever
 * extraction, normalization or fingerprinting changes, then run
 * `proa reindex`. The corpus snapshots in `test/__snapshots__` change with
 * every such change and are the reminder.
 */
export const FACTS_VERSION = '1';
