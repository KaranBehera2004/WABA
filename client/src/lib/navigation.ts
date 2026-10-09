export function readSavedSection(key: string, sections: readonly string[], fallback: string): string {
  try {
    const saved = sessionStorage.getItem(key);
    return saved && sections.includes(saved) ? saved : fallback;
  } catch {
    return fallback;
  }
}

export function saveSection(key: string, section: string): void {
  try { sessionStorage.setItem(key, section); } catch { /* Navigation still works when browser storage is unavailable. */ }
}
import { useEffect, useState } from 'react';


function sectionFromUrl(parameter: string, sections: readonly string[]): string | null {
  const value = new URL(window.location.href).searchParams.get(parameter);
  return value && sections.includes(value) ? value : null;
}

function sectionUrl(parameter: string, section: string): URL {
  const url = new URL(window.location.href);
  url.searchParams.set(parameter, section);
  if (parameter === 'page' && section !== 'Settings') url.searchParams.delete('settings');
  if (parameter === 'page' && section !== 'Inbox') { url.searchParams.delete('inbox'); url.searchParams.delete('conversation'); }
  return url;
}

export function useSectionNavigation(key: string, sections: readonly string[], fallback: string, parameter: string, enabled = true): [string, (section: string) => void] {
  const sectionsKey = sections.join('\u0000');
  const [section, setSection] = useState(() => sectionFromUrl(parameter, sections) || readSavedSection(key, sections, fallback));

  useEffect(() => {
    if (!enabled) return;
    const initial = sectionFromUrl(parameter, sections) || readSavedSection(key, sections, fallback);
    window.history.replaceState(window.history.state, '', sectionUrl(parameter, initial));
    setSection(initial);
    saveSection(key, initial);
    const restore = () => {
      const previous = sectionFromUrl(parameter, sections) || fallback;
      setSection(previous);
      saveSection(key, previous);
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [key, parameter, sectionsKey, fallback, enabled]);

  const navigate = (next: string) => {
    if (!enabled || !sections.includes(next) || next === section) return;
    window.history.pushState(window.history.state, '', sectionUrl(parameter, next));
    saveSection(key, next);
    setSection(next);
  };
  return [section, navigate];
}
