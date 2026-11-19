// Translations for the overlay and the control panel. The strings live in
// lang/<id>.json, one file per language, shared with the server. English is
// the source: a key missing from another language shows in English.
//
// The language follows the control panel's setting, which arrives with the
// state; `?lang=de` in a page's address pins one, the way `?theme=` pins a theme.
'use strict';

const I18n = (() => {
  const pinned = new URLSearchParams(location.search).get('lang');
  const files = new Map();
  let english = {};
  let strings = {};
  let current = 'en';
  /** The language asked for last: a slow file that arrives after a newer choice is dropped. */
  let wanted = 'en';
  const listeners = [];

  /** Remembered in this browser, so a page starts in the last language instead of flashing English. */
  function remembered(value) {
    try {
      if (value === undefined) return localStorage.getItem('chroma-clash-language');
      localStorage.setItem('chroma-clash-language', value);
    } catch {
      // private window or blocked storage
    }
    return null;
  }

  async function load(id) {
    if (!files.has(id)) {
      files.set(id, fetch(`/lang/${encodeURIComponent(id)}.json`, { cache: 'no-store' }).then((response) => {
        if (!response.ok) throw new Error(`No language file for "${id}"`);
        return response.json();
      }));
    }
    try {
      return await files.get(id);
    } catch (error) {
      files.delete(id);
      throw error;
    }
  }

  /** Switches to a language; resolves once its strings are in. An unknown one leaves the current. */
  async function use(id) {
    if (!id) return;
    wanted = id;
    try {
      const [base, chosen] = await Promise.all([load('en'), load(id)]);
      if (wanted !== id) return;
      const changed = id !== current || strings !== chosen;
      english = base;
      strings = chosen;
      current = id;
      document.documentElement.lang = id;
      if (!pinned) remembered(id);
      if (changed) for (const listener of listeners) listener(id);
    } catch (error) {
      console.warn(error.message);
    }
  }

  function lookup(key) {
    return key in strings ? strings[key] : english[key];
  }

  /**
   * The text for a key, with `{name}` placeholders filled from `params`. A value
   * of the form { one, other } is picked by `params.count`. A key nobody wrote
   * comes back as itself, which is easy to spot.
   */
  function t(key, params = {}) {
    const value = lookup(key);
    if (value === undefined) return key;
    const chosen = typeof value === 'string' ? value : params.count === 1 ? value.one : value.other;
    return chosen.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
  }

  /**
   * Fills the static text of a page: `data-i18n` sets the text, `data-i18n-html`
   * the markup (the language files are ours, so markup in them is trusted),
   * and `data-i18n-placeholder`, `-title` and `-aria-label` those attributes.
   */
  function translatePage(root = document) {
    for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
    for (const element of root.querySelectorAll('[data-i18n-html]')) element.innerHTML = t(element.dataset.i18nHtml);
    for (const [attribute, data] of [['placeholder', 'i18nPlaceholder'], ['title', 'i18nTitle'], ['aria-label', 'i18nAriaLabel']]) {
      for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) element.setAttribute(attribute, t(element.dataset[data]));
    }
  }

  // English always loads, with the pinned or remembered language; a language that is gone falls back to it.
  const ready = use(pinned || remembered() || 'en').then(() => (Object.keys(english).length ? undefined : use('en')));

  return {
    /** The language in use, such as `en` or `de`. */
    get language() {
      return current;
    },
    /** A language from the page address, which wins over the control panel's setting; or null. */
    pinned,
    /** Resolves once the first language is loaded: wait for it before drawing text. */
    ready,
    t,
    translatePage,
    /** The server's setting arrived: switch to it, unless the address pins a language. */
    follow(id) {
      if (!pinned && id && id !== wanted) use(id);
    },
    /** Called with the new language id each time it changes, once its strings are in. */
    onChange(listener) {
      listeners.push(listener);
    },
  };
})();

/** Shorthand for I18n.t; not `t`, which the pages use for times and tiles. */
const tr = I18n.t;
