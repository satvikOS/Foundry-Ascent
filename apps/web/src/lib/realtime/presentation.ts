import type { AvatarProvider } from './avatar';

export type LocalPresentation = 'sphere' | 'character';

/** Negotiated capabilities: the conversation never assumes remote and local providers are equivalent. */
export interface PresentationCapabilities {
  readonly audioOwner: 'engine' | 'presentation';
  readonly synchronization: 'amplitude' | 'provider';
  readonly remote: boolean;
  readonly visemes: false;
  readonly interruption: 'local' | 'local-and-remote';
}

export function presentationCapabilities(provider: AvatarProvider): PresentationCapabilities {
  const remote = provider.voicing !== 'engine';
  return {
    audioOwner: remote ? 'presentation' : 'engine',
    synchronization: remote ? 'provider' : 'amplitude',
    remote,
    visemes: false,
    interruption: remote ? 'local-and-remote' : 'local',
  };
}

/** Loaded only when the student selects a character. Failure leaves the working sphere and voice intact. */
export async function loadLocalCharacter(): Promise<AvatarProvider> {
  const { LocalCharacter } = await import('./character');
  return new LocalCharacter();
}
