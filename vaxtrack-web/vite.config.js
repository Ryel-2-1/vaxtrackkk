import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const commonHeaders = {
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

/*
  Dev CSP is relaxed because Vite development mode uses React Refresh/HMR.
  Do not use npm run dev for the final ZAP report.
*/
const devCsp = [
  "default-src 'self'",
  // NOTE: `https://maps.googleapis.com` (+ maps.gstatic / *.googleapis wildcards
  // in img-src/connect-src) are TEMPORARY additions for the Google Maps
  // feasibility spike. Remove on rollback.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com https://apis.google.com https://accounts.google.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://www.gstatic.com https://tile.openstreetmap.org https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.gstatic.com",
  "connect-src 'self' ws://localhost:* http://localhost:* https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://accounts.google.com https://apis.google.com https://www.gstatic.com https://api.openrouteservice.org https://maps.googleapis.com",
  "frame-src 'self' https://accounts.google.com",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
  "media-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

/*
  Production preview CSP is stricter.
  Use npm run build + npm run preview for the ZAP scan.
*/
const previewCsp = [
  "default-src 'self'",
  // TEMPORARY Google Maps feasibility-spike additions (remove on rollback).
  "script-src 'self' https://www.gstatic.com https://apis.google.com https://accounts.google.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://lh3.googleusercontent.com https://www.gstatic.com https://tile.openstreetmap.org https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.gstatic.com",
  "connect-src 'self' https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://accounts.google.com https://apis.google.com https://www.gstatic.com https://api.openrouteservice.org https://maps.googleapis.com",
  "frame-src 'self' https://accounts.google.com",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
  "media-src 'self'",
  "worker-src 'self' blob:",
].join("; ");

export default defineConfig({
  plugins: [react()],

  server: {
    headers: {
      ...commonHeaders,
      "Content-Security-Policy": devCsp,
    },
  },

  preview: {
    headers: {
      ...commonHeaders,
      "Content-Security-Policy": previewCsp,
    },
  },
});