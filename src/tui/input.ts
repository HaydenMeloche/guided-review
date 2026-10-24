import { createContext, useContext } from 'react';
import { useInput as inkUseInput } from 'ink';

// Whether the screens may take keys. App turns it off while it asks a question over everything
// (the quit question), since Ink calls every active input handler: without this, the key that
// answers the question would also act on the screen or popup under it.
export const KeysLive = createContext(true);

// Ink's useInput, quiet while KeysLive is off. Screens import it from here rather than from Ink.
export function useInput(handler: Parameters<typeof inkUseInput>[0], options?: { isActive?: boolean }): void {
  const live = useContext(KeysLive);
  inkUseInput(handler, { isActive: live && options?.isActive !== false });
}
