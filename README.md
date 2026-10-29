# Dark Theme DJ Mixer

App #10 del reto [101 great ideas](https://github.com/briandh5/101greatideas). Mezcladora DJ en el navegador con estética de hardware profesional: fondos carbón y negro, detalles neón que se encienden al tocar.

## Qué hace

- **Dos decks (A y B):** carga audio local con el botón *Cargar* o arrastrando el archivo. Play/Pausa, Cue (en pausa marca el punto, mantenlo para escuchar, en reproducción regresa al punto), forma de onda para saltar, jog giratorio (busca en pausa, empuja el tempo en reproducción) y tempo ±8 %.
- **Mixer central:** EQ de 3 bandas por canal, fader de volumen, vúmetros LED, master y **crossfader** con curva de potencia constante.
- **Sampler de 8 pads:** Air Horn, Scratch, Hey!, Wooo!, Rewind, Sirena, Láser y 808 Drop, todos sintetizados con Web Audio (sin archivos externos). Cada pad tiene un botón para reemplazar su sonido con un audio corto propio (hasta 20 s) y otro para volver al original. Teclas 1–8.
- **Portadas en el disco:** el plato muestra la portada en todo el vinilo, con surcos y reflejo. Se toma de Audius o de la imagen incrustada en el archivo (MP3 con ID3, M4A y FLAC); si no trae, el botón de imagen junto al plato permite subir una.
- **Buscador de Audius:** cada deck busca y carga canciones completas de artistas independientes en [Audius](https://audius.co) (API abierta, sin llave). El audio pasa por EQ, crossfader y tempo. Spotify y YouTube no lo permiten (DRM). No funciona dentro de la vista previa de Artifacts porque ahí el internet está bloqueado.
- **Luces al ritmo:** el fondo (halos, piso de rejilla neón y haces de luz) pulsa con el BPM de lo que suena. La app detecta el BPM y la fase del beat de cada canción que cargas (graves → autocorrelación) y mezcla las luces según el crossfader y el nivel real de cada deck. Se apaga con el botón *Luces* y respeta “reducir movimiento”.
- **Pistas demo:** dos pistas a 124 BPM en La menor se generan al abrir la app para poder mezclar sin cargar nada.

## Correr

```bash
npm install
npm run dev        # desarrollo
npm run build      # producción (Vercel la detecta como Vite)
npm run artifact   # un solo HTML para la vista previa
```

Stack: Vite + React 19 + Tailwind 3 + Web Audio API. Todo vive en un solo componente: `src/DJMixer.jsx`.
