import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './react-shell.css';

const legacyMarker = 'data-global-rani-legacy-head';

function getLegacyTemplatePath() {
  let pathname = window.location.pathname || '/';
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (!pathname.endsWith('.html')) {
    pathname = pathname.replace(/\/$/, '') + '/index.html';
  }
  return `/legacy${pathname}`;
}

function resolveUrl(value) {
  if (!value) return value;
  try {
    return new URL(value, window.location.href).href;
  } catch {
    return value;
  }
}

async function executeScript(sourceScript, targetParent) {
  const type = (sourceScript.getAttribute('type') || '').trim().toLowerCase();
  if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) {
    const inert = document.createElement('script');
    [...sourceScript.attributes].forEach(({ name, value }) => inert.setAttribute(name, value));
    inert.textContent = sourceScript.textContent || '';
    targetParent.appendChild(inert);
    return;
  }

  await new Promise((resolve) => {
    const script = document.createElement('script');
    [...sourceScript.attributes].forEach(({ name, value }) => {
      if (name === 'src') script.src = resolveUrl(value);
      else script.setAttribute(name, value);
    });
    if (sourceScript.src || sourceScript.getAttribute('src')) {
      script.async = false;
      script.onload = resolve;
      script.onerror = resolve;
      targetParent.appendChild(script);
    } else {
      script.textContent = sourceScript.textContent || '';
      targetParent.appendChild(script);
      resolve();
    }
  });
}

function copyHead(doc) {
  document.head.querySelectorAll(`[${legacyMarker}]`).forEach((node) => node.remove());

  const title = doc.querySelector('title');
  if (title?.textContent) document.title = title.textContent;

  doc.head.querySelectorAll('meta, link[rel="stylesheet"], style').forEach((node) => {
    const clone = node.cloneNode(true);
    clone.setAttribute(legacyMarker, 'true');
    if (clone.tagName === 'LINK' && clone.getAttribute('href')) {
      clone.setAttribute('href', resolveUrl(clone.getAttribute('href')));
    }
    document.head.appendChild(clone);
  });
}

function LegacyPage() {
  const mountRef = useRef(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const generatedScripts = [];

    async function loadPage() {
      try {
        const templatePath = getLegacyTemplatePath();
        const response = await fetch(templatePath, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Page not found (${response.status})`);

        const html = await response.text();
        if (cancelled) return;

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        copyHead(doc);

        // Preserve page-level classes/attributes used by the original CSS.
        document.documentElement.className = doc.documentElement.className || '';
        document.body.className = doc.body.className || '';
        [...doc.body.attributes].forEach(({ name, value }) => {
          if (name !== 'class') document.body.setAttribute(name, value);
        });

        const bodyScripts = [...doc.body.querySelectorAll('script')];
        bodyScripts.forEach((s) => s.remove());
        mountRef.current.innerHTML = doc.body.innerHTML;

        // Head scripts first, then body scripts, preserving the legacy site's expectations.
        const allScripts = [...doc.head.querySelectorAll('script'), ...bodyScripts];
        for (const sourceScript of allScripts) {
          if (cancelled) return;
          const holder = document.createElement('span');
          holder.hidden = true;
          holder.setAttribute('data-global-rani-runtime-script', 'true');
          mountRef.current.appendChild(holder);
          const before = holder.childNodes.length;
          await executeScript(sourceScript, holder);
          if (holder.childNodes.length > before) generatedScripts.push(holder.lastChild);
        }

        // Legacy pages register many startup handlers after React has mounted.
        // Re-fire the lifecycle events so those handlers initialize normally.
        document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
        window.dispatchEvent(new Event('load'));
      } catch (err) {
        console.error(err);
        setError(err instanceof Error ? err.message : 'Unable to load this page.');
      }
    }

    loadPage();
    return () => {
      cancelled = true;
      generatedScripts.forEach((script) => script?.remove());
      document.head.querySelectorAll(`[${legacyMarker}]`).forEach((node) => node.remove());
    };
  }, []);

  if (error) {
    return (
      <main className="react-migration-error">
        <h1>Global Rani</h1>
        <p>{error}</p>
        <a href="/">Return to the home page</a>
      </main>
    );
  }

  return <div ref={mountRef} data-react-page-root="true" />;
}

createRoot(document.getElementById('root')).render(<LegacyPage />);
