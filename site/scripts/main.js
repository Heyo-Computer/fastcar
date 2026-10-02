/**
 * fastcar marketing site — minimal JS
 * - Smooth-scroll for in-page anchor links (progressive enhancement on top
 *   of CSS `scroll-behavior: smooth`, with a reduced-motion guard).
 * - Mobile navigation toggle (hamburger) with accessible aria-expanded.
 * - Close the mobile nav after following an in-page link.
 */
(function () {
    "use strict";

    var prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
    ).matches;

    // ---- Mobile nav toggle -------------------------------------------------
    var toggle = document.getElementById("navToggle");
    var links = document.getElementById("navLinks");

    if (toggle && links) {
        toggle.addEventListener("click", function () {
            var open = links.classList.toggle("is-open");
            toggle.setAttribute("aria-expanded", open ? "true" : "false");
        });

        // Close the menu after picking an in-page link so it doesn't sit
        // open over the section the user just jumped to.
        links.addEventListener("click", function (event) {
            var target = event.target.closest('a[href^="#"]');
            if (!target) return;
            links.classList.remove("is-open");
            toggle.setAttribute("aria-expanded", "false");
        });
    }

    // ---- Smooth scroll for in-page anchors --------------------------------
    // CSS handles this via `scroll-behavior: smooth`; we add it as a JS
    // fallback for older browsers and to honor reduced-motion explicitly.
    if (!prefersReducedMotion && !("scrollBehavior" in document.documentElement.style)) {
        document.addEventListener("click", function (event) {
            var anchor = event.target.closest('a[href^="#"]');
            if (!anchor) return;
            var hash = anchor.getAttribute("href");
            if (hash === "#" || hash.length < 2) return;
            var el = document.querySelector(hash);
            if (!el) return;
            event.preventDefault();
            el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    }
})();
