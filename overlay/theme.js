// Themes: how the overlay looks. See themes/README.md for how to make one.
//
// A theme is a folder in overlay/themes/ with a theme.json. It may name:
// - "script": a file that calls Theme.register({...}) with drawing functions
//   that replace the built-in ones for some elements;
// - "images": files that replace single elements outright (image packs);
// - "font", "pixelScale", "palette": the theme's font, chunkiness and colors;
// - "ink", "halftone": comic-book outlines and dot shading over everything.
// Whatever a theme leaves out is drawn the built-in way.
'use strict';

const Theme = (() => {
  const BASE_FONT = '"Inter", "Segoe UI", system-ui, sans-serif';
  const DEFAULT_PALETTE = {
    panel: 'rgba(17, 20, 24, 0.82)',
    panelStrong: 'rgba(17, 20, 24, 0.9)',
    neutralTile: 'rgba(255, 255, 255, 0.10)',
    neutralTileBig: '#2A3038',
    text: '#FFFFFF',
    stone: '#C9C2B5',
  };

  /** Drawing functions registered by theme scripts, by theme id. */
  const scripts = {};
  /** Script registrations waiting for the theme that loads them. */
  let pendingRegistration = null;

  const current = {
    id: 'plain',
    name: 'Plain',
    pixelScale: 1,
    hardEdges: false,
    ink: null,
    halftone: null,
    font: BASE_FONT,
    fontScale: 1,
    palette: { ...DEFAULT_PALETTE },
    art: {},
    images: new Map(),
  };
  let loading = null;
  let onChange = () => {};

  function loadImage(url) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url;
    });
  }

  function loadScript(url) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  /** Reads a theme's description, following `extends` to the theme it builds on. */
  async function readTheme(id, seen = new Set()) {
    if (seen.has(id)) return null;
    seen.add(id);
    const folder = `themes/${encodeURIComponent(id)}/`;
    let json;
    try {
      const response = await fetch(`${folder}theme.json`, { cache: 'no-store' });
      if (!response.ok) return null;
      json = await response.json();
    } catch {
      return null;
    }
    const parent = json.extends ? await readTheme(json.extends, seen) : null;

    if (json.script && !scripts[id]) {
      pendingRegistration = id;
      await loadScript(`${folder}${json.script}`);
      pendingRegistration = null;
    }

    const theme = {
      id,
      name: json.name || id,
      pixelScale: json.pixelScale ?? parent?.pixelScale ?? 1,
      hardEdges: json.hardEdges ?? parent?.hardEdges ?? false,
      ink: json.ink ?? parent?.ink ?? null,
      halftone: json.halftone ?? parent?.halftone ?? null,
      font: parent?.font ?? BASE_FONT,
      fontScale: json.fontScale ?? parent?.fontScale ?? 1,
      palette: { ...DEFAULT_PALETTE, ...(parent?.palette || {}), ...(json.palette || {}) },
      art: { ...(parent?.art || {}), ...(scripts[id]?.art || {}) },
      images: new Map(parent?.images || []),
    };

    if (json.font && json.font.family && json.font.file) {
      try {
        const descriptors = json.font.weight ? { weight: String(json.font.weight) } : {};
        const face = new FontFace(json.font.family, `url(${folder}${json.font.file})`, descriptors);
        await face.load();
        document.fonts.add(face);
        theme.font = `"${json.font.family}", ${BASE_FONT}`;
      } catch {
        // The font did not load: the theme still works with the default one.
      }
    }

    const entries = Object.entries(json.images || {});
    const loaded = await Promise.all(entries.map(([, file]) => loadImage(`${folder}${file}`)));
    entries.forEach(([key], index) => {
      if (loaded[index]) theme.images.set(key, loaded[index]);
    });
    return theme;
  }

  return {
    get current() {
      return current;
    },
    /** Called by a theme's script to add its drawing functions. */
    register(definition) {
      const id = definition.id || pendingRegistration;
      if (id) scripts[id] = definition;
    },
    /** Called with a function that redraws the overlay when a theme has loaded. */
    onChange(callback) {
      onChange = callback;
    },
    /** Switches to a theme. Loading happens in the background; until then the old one stays. */
    use(id) {
      if (!id || id === current.id || id === loading) return;
      loading = id;
      readTheme(id).then((theme) => {
        if (loading !== id) return;
        loading = null;
        if (!theme) return;
        Object.assign(current, theme);
        onChange();
      });
    },
    /** The image a theme supplies for an element, or null. */
    image(key) {
      return current.images.get(key) || null;
    },
  };
})();
