export interface SecretStore {
  init?(): Promise<void>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  getLegacy?(key: string): Promise<string | undefined>;
  deleteLegacy?(key: string): Promise<void>;
  listLegacyCandidates?(): Promise<readonly { id: string; value: string }[]>;
  deleteLegacyCandidate?(id: string): Promise<void>;
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
