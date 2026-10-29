export type LocalConfig = {
  version?: number;
  components?: string[];
  raycastTarget?: string;
  repositoryPath?: string;
  libraryPath?: string;
  atlasPath?: string;
  nodePath?: string;
  pythonPath?: string;
  rm2Path?: string;
  pdfinfoPath?: string;
  pdftoppmPath?: string;
  focusStatePath?: string;
};
export function configPath(home?: string): string;
export function readLocalConfig(home?: string): LocalConfig;

export function validateConfig(value: unknown): LocalConfig;
export function recordOverrides(
  component: string,
  preferences: Record<string, unknown>,
  common: LocalConfig,
): void;
