"use client";

import { useEffect } from "react";

export function LoadDebug() {
  useEffect(() => {
    const tag = "[load-debug]";
    const html = document.documentElement;
    const body = document.body;
    const htmlStyle = getComputedStyle(html);
    const bodyStyle = getComputedStyle(body);

    console.group(`${tag} mount`);
    console.log("location:", window.location.href);
    console.log("userAgent:", navigator.userAgent);
    console.log("html classes:", html.className);

    const cssVars = [
      "--font-geist-sans",
      "--font-geist-mono",
      "--font-sans",
      "--font-mono",
      "--background",
      "--foreground",
    ];
    console.log(
      "CSS vars:",
      Object.fromEntries(
        cssVars.map((v) => [v, htmlStyle.getPropertyValue(v).trim() || "(empty)"]),
      ),
    );

    console.log("computed html.font-family:", htmlStyle.fontFamily);
    console.log("computed body.font-family:", bodyStyle.fontFamily);
    console.log("computed body.background-color:", bodyStyle.backgroundColor);

    const linkEls = Array.from(document.querySelectorAll("link[rel=stylesheet]"));
    console.log(
      "stylesheet links:",
      linkEls.map((l) => (l as HTMLLinkElement).href),
    );

    const tailwindSentinels = ["bg-background", "font-sans", "flex"];
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);
    const sentinelResults = tailwindSentinels.map((cls) => {
      probe.className = cls;
      const cs = getComputedStyle(probe);
      return {
        cls,
        display: cs.display,
        fontFamily: cs.fontFamily,
        backgroundColor: cs.backgroundColor,
      };
    });
    probe.remove();
    console.log("tailwind class probes:", sentinelResults);

    if (document.fonts) {
      document.fonts.ready
        .then(() => {
          const loaded = Array.from(document.fonts).map((f) => ({
            family: f.family,
            status: f.status,
            style: f.style,
            weight: f.weight,
          }));
          console.log(`${tag} document.fonts.ready — loaded fonts:`, loaded);
          const geistLoaded = loaded.some((f) =>
            /geist/i.test(f.family),
          );
          console.log(`${tag} Geist font registered:`, geistLoaded);
        })
        .catch((err) => console.error(`${tag} fonts.ready error`, err));
    } else {
      console.warn(`${tag} document.fonts not available`);
    }

    console.groupEnd();
  }, []);

  return null;
}
