/* =========================================================================
   VocaLink app.js
   1. Theme controller (light/dark, auto-detect + toggle + persistence)
   2. Three.js background (visible assets, theme-aware, pointer repel)
   3. Live translator (Deepgram + browser fallback + Google Translate)
   4. Reveal-on-scroll observer
   ========================================================================= */

/* -------------------------------------------------------------------------
   1. THEME CONTROLLER
------------------------------------------------------------------------- */
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('themeBtn');
  var stored = null;
  try { stored = localStorage.getItem('vl_theme'); } catch (e) {}
  var prefers = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');

  function apply(mode) {
    root.setAttribute('data-theme', mode);
    if (btn) btn.innerHTML = mode === 'dark' ? '&#9728;' : '&#127769;';
    /* Notify the Three.js scene so it can recolor its environment map */
    if (typeof window.__vlSetTheme === 'function') {
      window.__vlSetTheme(mode);
    }
  }

  var initial = stored || (prefers && prefers.matches ? 'dark' : 'light');
  apply(initial);

  if (btn) {
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('vl_theme', next); } catch (e) {}
      apply(next);
    });
  }

  if (prefers && prefers.addEventListener) {
    prefers.addEventListener('change', function (e) {
      var s = null;
      try { s = localStorage.getItem('vl_theme'); } catch (err) {}
      if (!s) apply(e.matches ? 'dark' : 'light');
    });
  }
})();


/* -------------------------------------------------------------------------
   2. THREE.JS BACKGROUND
   Camera distance chosen so every asset (widest at x = +/- 10.6) stays
   inside the frustum at every realistic aspect ratio. No scroll drift.
------------------------------------------------------------------------- */
(function () {
  var canvas = document.getElementById('bg3d');
  if (!window.THREE || !canvas) return;

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  } catch (e) { return; }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);

  /* z = 22, fov = 42. At 16:9 half-height is about 8.4 units, half-width
     about 15 units. Widest asset is +/- 10.6, so it is comfortably inside.
     At 4:3 half-width drops to about 11.2, still clears +/- 10.6. */
  camera.position.z = 22;

  /* --- Studio environment map, rebuilt per theme --- */
  var pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  var envTexture = null;

  function buildEnvironment(isDark) {
    var envScene = new THREE.Scene();

    var baseColor = isDark ? 0x1f2823 : 0xcfc8bb;
    envScene.add(new THREE.Mesh(
      new THREE.SphereGeometry(60, 32, 16),
      new THREE.MeshBasicMaterial({ color: baseColor, side: THREE.BackSide })
    ));

    /* Light panels: [x, y, z, width, height, [r, g, b]] */
    var lights = isDark
      ? [
          [ 0,  30,  10, 50, 18, [1.5, 1.3, 1.2]],
          [-32,  8,   2, 16, 34, [1.1, 0.9, 0.8]],
          [ 32, -2,  -8, 14, 34, [0.8, 1.0, 1.2]],
          [  0,-30,   4, 44, 12, [0.45, 0.4, 0.38]]
        ]
      : [
          [ 0,  30,  10, 50, 18, [4, 4, 4]],
          [-32,  8,   2, 16, 34, [4, 3.4, 2.8]],
          [ 32, -2,  -8, 14, 34, [2.2, 2.8, 3.6]],
          [  0,-30,   4, 44, 12, [1.6, 1.4, 1.2]]
        ];

    lights.forEach(function (b) {
      var mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      mat.color.setRGB(b[5][0], b[5][1], b[5][2]);
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(b[3], b[4]), mat);
      mesh.position.set(b[0], b[1], b[2]);
      mesh.lookAt(0, 0, 0);
      envScene.add(mesh);
    });

    var tex = pmrem.fromScene(envScene, 0.04).texture;

    /* Dispose previous map so we do not leak GPU memory on theme flips */
    if (envTexture && envTexture !== tex) {
      try { envTexture.dispose(); } catch (e) {}
    }
    envTexture = tex;
    scene.environment = envTexture;

    /* Also retint the point cloud and any cached materials */
    if (typeof retintScene === 'function') retintScene(isDark);
  }

  /* --- Lighting --- */
  var hemi = new THREE.HemisphereLight(0xfff4e6, 0xb8c6bb, 0.7);
  scene.add(hemi);

  var dir = new THREE.DirectionalLight(0xfff0dc, 1.1);
  dir.position.set(-6, 10, 8);
  scene.add(dir);

  /* --- Materials --- */
  function glassMat() {
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 0.12,
      transparent: true,
      opacity: 0.42,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.5
    });
  }
  function metal(c, r) {
    return new THREE.MeshStandardMaterial({
      color: c, metalness: 1, roughness: r, envMapIntensity: 1.3
    });
  }
  function matte(c, r) {
    return new THREE.MeshStandardMaterial({
      color: c, metalness: 0, roughness: r
    });
  }

  /* Rounded slab geometry for the glass panels */
  function slabGeo(w, h, r, d) {
    var s = new THREE.Shape();
    var x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    var g = new THREE.ExtrudeGeometry(s, {
      depth: d,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 3
    });
    g.center();
    return g;
  }

  /* --- Scene items --- */
  var items = [];

  function add(geo, mat, x, y, z, s, spin, rot) {
    var m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.scale.setScalar(s);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.userData = {
      hx: x, hy: y, ox: 0, oy: 0, vx: 0, vy: 0,
      spin: spin, ph: Math.random() * 6.28,
      isGlass: mat.transparent === true
    };
    scene.add(m);
    items.push(m);
    return m;
  }

  /* Assets arranged in a ring around center so nothing clips the frustum */
  add(new THREE.TorusKnotGeometry(0.8, 0.3, 220, 24), metal(0xd9a17e, 0.2),
      6.6, 0.3, -2.5, 2.1, [0.0025, 0.004]);

  add(slabGeo(2.6, 1.7, 0.25, 0.08), glassMat(),
      -8, 3.3, -3, 1.6, [0.002, 0.003], [0.3, 0.5, 0.2]);

  add(slabGeo(2.2, 1.5, 0.22, 0.08), glassMat(),
      9.6, -4, -1.5, 1.3, [0.003, 0.002], [-0.4, -0.5, 0.3]);

  add(slabGeo(2, 1.3, 0.2, 0.07), glassMat(),
      3, 5.2, -4, 1.1, [0.002, 0.004], [0.5, -0.3, 0.1]);

  add(new THREE.SphereGeometry(1, 48, 48), matte(0xd8a58c, 0.6),
      -9.6, -3, -2, 1.15, [0.001, 0.002]);

  add(new THREE.SphereGeometry(1, 48, 48), matte(0xe8bda6, 0.55),
      1.6, -5.8, -1, 0.7, [0.001, 0.002]);

  add(new THREE.SphereGeometry(1, 48, 48), matte(0x9db3a3, 0.5),
      -3.6, -6.2, -3, 1, [0.001, 0.002]);

  add(new THREE.DodecahedronGeometry(1, 0), matte(0xcdbfae, 0.95),
      -1.6, 5.8, -5, 1, [0.004, 0.003]);

  add(new THREE.TorusGeometry(1, 0.1, 20, 90), metal(0xd7a07f, 0.22),
      10.4, 4.6, -4, 1.5, [0.004, 0.002], [0.6, 0.3, 0]);

  add(new THREE.TorusGeometry(1, 0.08, 20, 90), metal(0xbfcfc4, 0.25),
      -10.6, 0.6, -5, 1.2, [0.003, 0.004], [0.4, 0.7, 0]);

  /* --- Starfield --- */
  var starGeo = new THREE.BufferGeometry();
  var starCount = 150;
  var starPos = new Float32Array(starCount * 3);
  for (var i = 0; i < starCount; i++) {
    starPos[i * 3]     = (Math.random() - 0.5) * 34;
    starPos[i * 3 + 1] = (Math.random() - 0.5) * 20;
    starPos[i * 3 + 2] = (Math.random() - 0.5) * 14 - 4;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  var starMat = new THREE.PointsMaterial({
    color: 0xffffff, size: 0.06, transparent: true, opacity: 0.8
  });
  var stars = new THREE.Points(starGeo, starMat);
  scene.add(stars);

  /* --- Theme retint hook --- */
  var isDarkTheme = document.documentElement.getAttribute('data-theme') === 'dark';

  function retintScene(isDark) {
    isDarkTheme = isDark;

    /* Hemisphere and directional shift subtly */
    hemi.color.setHex(isDark ? 0xc8d8d0 : 0xfff4e6);
    hemi.groundColor.setHex(isDark ? 0x1a2320 : 0xb8c6bb);
    hemi.intensity = isDark ? 0.55 : 0.7;

    dir.color.setHex(isDark ? 0xd8e8dc : 0xfff0dc);
    dir.intensity = isDark ? 0.9 : 1.1;

    /* Stars: brighter on dark, dimmer on light */
    starMat.opacity = isDark ? 0.9 : 0.5;
    starMat.color.setHex(isDark ? 0xf0f5f0 : 0xffffff);

    /* Glass panels: slightly less white on dark so they read as glass */
    items.forEach(function (m) {
      if (m.userData.isGlass) {
        m.material.color.setHex(isDark ? 0xb8c8c0 : 0xffffff);
        m.material.opacity = isDark ? 0.32 : 0.42;
      } else {
        /* Solid assets: dim just a touch on dark */
        if (m.material && m.material.color) {
          var base = m.material.userData.baseColor;
          if (base === undefined) {
            m.material.userData.baseColor = m.material.color.getHex();
            base = m.material.userData.baseColor;
          }
          var c = new THREE.Color(base);
          if (isDark) c.multiplyScalar(0.75);
          m.material.color.copy(c);
        }
      }
    });
  }

  /* Expose to the theme controller */
  window.__vlSetTheme = function (mode) {
    buildEnvironment(mode === 'dark');
  };

  /* --- Resize --- */
  function resize() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  /* --- Pointer tracking + card tilt --- */
  var mx = 0, my = 0, tx = 0, ty = 0;
  var panel = document.querySelector('.stage');

  window.addEventListener('pointermove', function (e) {
    tx = (e.clientX / window.innerWidth) * 2 - 1;
    ty = -((e.clientY / window.innerHeight) * 2 - 1);

    if (panel) {
      var r = panel.getBoundingClientRect();
      var px = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
      var py = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      panel.style.transform =
        'perspective(900px) rotateY(' + (px * 10) + 'deg) rotateX(' + (-py * 8) + 'deg)';
    }
  }, { passive: true });

  /* --- Frame loop --- */
  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var t = 0;

  function frame() {
    t += 0.01;
    mx += (tx - mx) * 0.06;
    my += (ty - my) * 0.06;

    camera.position.x = mx * 1.4;
    camera.position.y = my * 1.0;
    camera.lookAt(0, 0, 0);

    items.forEach(function (m) {
      var d = m.userData;

      /* Slow idle spin */
      m.rotation.x += d.spin[0];
      m.rotation.y += d.spin[1];

      /* Float */
      m.position.y = d.hy + d.oy + Math.sin(t + d.ph) * 0.25;
      m.position.x = d.hx + d.ox;
    });

    stars.rotation.y = t * 0.02 + mx * 0.15;
    stars.rotation.x = my * 0.08;

    renderer.render(scene, camera);

    if (!reduce) requestAnimationFrame(frame);
  }

  /* Boot: build initial environment for current theme, then start loop */
  buildEnvironment(isDarkTheme);
  frame();
})();


/* -------------------------------------------------------------------------
   3. LIVE TRANSLATOR
------------------------------------------------------------------------- */

/* Language table. Format per entry: google~Name~deepgram~browserSpeechLocale
   Empty deepgram field = not streamable via Deepgram, will use browser engine.
   Empty browserSpeechLocale = not recognized by browser, target-only. */
var RAW =
  "af~Afrikaans~~af-ZA;sq~Albanian~~sq-AL;am~Amharic~~am-ET;ar~Arabic~~ar-SA;" +
  "hy~Armenian~~hy-AM;as~Assamese;ay~Aymara;az~Azerbaijani~~az-AZ;bm~Bambara;" +
  "eu~Basque~~eu-ES;be~Belarusian;bn~Bengali~~bn-BD;bho~Bhojpuri;bs~Bosnian~~bs-BA;" +
  "bg~Bulgarian~bg~bg-BG;ca~Catalan~ca~ca-ES;ceb~Cebuano;" +
  "zh-CN~Chinese (Simplified)~zh~zh-CN;zh-TW~Chinese (Traditional)~zh-TW~zh-TW;" +
  "co~Corsican;hr~Croatian~~hr-HR;cs~Czech~cs~cs-CZ;da~Danish~da~da-DK;" +
  "dv~Dhivehi;doi~Dogri;nl~Dutch~nl~nl-NL;en~English~en~en-US;eo~Esperanto;" +
  "et~Estonian~et~et-EE;ee~Ewe;fil~Filipino~~fil-PH;fi~Finnish~fi~fi-FI;" +
  "fr~French~fr~fr-FR;fy~Frisian;gl~Galician~~gl-ES;ka~Georgian~~ka-GE;" +
  "de~German~de~de-DE;el~Greek~el~el-GR;gn~Guarani;gu~Gujarati~~gu-IN;" +
  "ht~Haitian Creole;ha~Hausa;haw~Hawaiian;iw~Hebrew~~he-IL;hi~Hindi~hi~hi-IN;" +
  "hmn~Hmong;hu~Hungarian~hu~hu-HU;is~Icelandic~~is-IS;ig~Igbo;ilo~Ilocano;" +
  "id~Indonesian~id~id-ID;ga~Irish;it~Italian~it~it-IT;ja~Japanese~ja~ja-JP;" +
  "jw~Javanese~~jv-ID;kn~Kannada~~kn-IN;kk~Kazakh~~kk-KZ;km~Khmer~~km-KH;" +
  "rw~Kinyarwanda;gom~Konkani;ko~Korean~ko~ko-KR;kri~Krio;" +
  "ku~Kurdish (Kurmanji);ckb~Kurdish (Sorani);ky~Kyrgyz;lo~Lao~~lo-LA;" +
  "la~Latin;lv~Latvian~lv~lv-LV;ln~Lingala;lt~Lithuanian~lt~lt-LT;lg~Luganda;" +
  "lb~Luxembourgish;mk~Macedonian~~mk-MK;mai~Maithili;mg~Malagasy;" +
  "ms~Malay~ms~ms-MY;ml~Malayalam~~ml-IN;mt~Maltese;mi~Maori;mr~Marathi~~mr-IN;" +
  "mni-Mtei~Meiteilon (Manipuri);lus~Mizo;mn~Mongolian~~mn-MN;" +
  "my~Myanmar (Burmese)~~my-MM;ne~Nepali~~ne-NP;no~Norwegian~no~nb-NO;" +
  "ny~Nyanja (Chichewa);or~Odia (Oriya);om~Oromo;ps~Pashto;fa~Persian~~fa-IR;" +
  "pl~Polish~pl~pl-PL;pt~Portuguese~pt~pt-BR;pa~Punjabi;qu~Quechua;" +
  "ro~Romanian~ro~ro-RO;ru~Russian~ru~ru-RU;sm~Samoan;sa~Sanskrit;" +
  "gd~Scots Gaelic;nso~Sepedi;sr~Serbian~~sr-RS;st~Sesotho;sn~Shona;" +
  "sd~Sindhi;si~Sinhala~~si-LK;sk~Slovak~sk~sk-SK;sl~Slovenian~~sl-SI;" +
  "so~Somali;es~Spanish~es~es-ES;su~Sundanese~~su-ID;sw~Swahili~~sw-TZ;" +
  "sv~Swedish~sv~sv-SE;tg~Tajik;ta~Tamil~~ta-IN;tt~Tatar;te~Telugu~~te-IN;" +
  "th~Thai~th~th-TH;ti~Tigrinya;ts~Tsonga;tr~Turkish~tr~tr-TR;tk~Turkmen;" +
  "ak~Twi (Akan);uk~Ukrainian~uk~uk-UA;ur~Urdu~~ur-PK;ug~Uyghur;" +
  "uz~Uzbek~~uz-UZ;vi~Vietnamese~vi~vi-VN;cy~Welsh;xh~Xhosa~~xh-ZA;" +
  "yi~Yiddish;yo~Yoruba;zu~Zulu~~zu-ZA";

var LANGS = RAW.split(';').map(function (s) {
  var parts = s.split('~');
  return {
    g:  parts[0],
    n:  parts[1],
    dg: parts[2] || '',
    sr: parts[3] || ''
  };
});

var AUTO = {
  g: 'auto',
  n: 'Auto-detect (10 languages via Deepgram)',
  dg: 'multi',
  sr: ''
};

var $ = function (id) { return document.getElementById(id); };

var src = $('src');
var tgt = $('tgt');
var dev = $('dev');
var go = $('go');
var feed = $('feed');
var interim = $('interim');
var statusEl = $('status');
var errEl = $('err');
var dgKey = $('dgKey');
var swapBtn = $('swap');
var expBtn = $('exp');
var txtInput = $('txt');
var tbtn = $('tbtn');
var diaToggle = $('dia');
var sayToggle = $('say');

var canBrowser = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

function findLang(code) {
  if (code === 'auto') return AUTO;
  for (var i = 0; i < LANGS.length; i++) {
    if (LANGS[i].g === code) return LANGS[i];
  }
  return null;
}

/* Populate the source dropdown:
   - Auto-detect always first (needs Deepgram key)
   - Then any language with a Deepgram code (streams) or browser speech locale */
(function populateSources() {
  src.appendChild(new Option(AUTO.n, AUTO.g));
  LANGS.forEach(function (l) {
    if (l.dg || (l.sr && canBrowser)) {
      var label = l.n + (l.dg ? '  \u26A1' : '');
      src.appendChild(new Option(label, l.g));
    }
  });
})();

/* Populate target dropdown with every language */
LANGS.forEach(function (l) {
  tgt.appendChild(new Option(l.n, l.g));
});

src.value = 'fr';
tgt.value = 'en';

/* Restore saved Deepgram key */
try { dgKey.value = localStorage.getItem('vl_dg') || ''; } catch (e) {}
dgKey.addEventListener('input', function () {
  try { localStorage.setItem('vl_dg', dgKey.value.trim()); } catch (e) {}
});

/* Swap source and target. Only swap if target can be a source. */
swapBtn.addEventListener('click', function () {
  var a = src.value;
  var b = tgt.value;
  if (a === 'auto') {
    /* Nothing useful to swap with auto */
    return;
  }
  var canBeSource = false;
  for (var i = 0; i < src.options.length; i++) {
    if (src.options[i].value === b) { canBeSource = true; break; }
  }
  if (canBeSource) {
    src.value = b;
    tgt.value = a;
  } else {
    /* Target has no source support; keep target, just reset source */
    tgt.value = a;
  }
});

/* --- Signature meter bars --- */
var sig = $('sig');
for (var si = 0; si < 56; si++) sig.appendChild(document.createElement('i'));
var bars = sig.children;

/* --- Hero waveform --- */
var wv = $('wave');
if (wv) {
  for (var wi = 0; wi < 40; wi++) {
    var wb = document.createElement('i');
    wb.style.animationDelay = (wi * 0.06) + 's';
    wv.appendChild(wb);
  }
}

function setStatus(text, isLive) {
  statusEl.textContent = text;
  go.classList.toggle('on', !!isLive);
}

/* --- Device enumeration --- */
function loadDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  navigator.mediaDevices.enumerateDevices().then(function (list) {
    var ins = list.filter(function (x) {
      return x.kind === 'audioinput' && x.label;
    });
    if (!ins.length) return;
    dev.innerHTML = '';
    ins.forEach(function (x) {
      var isBlackhole = /blackhole/i.test(x.label);
      dev.appendChild(new Option(x.label + (isBlackhole ? '  (Discord)' : ''), x.deviceId));
    });
  }).catch(function () {});
}
loadDevices();

/* --- Google Translate free endpoint --- */
function translate(text, sl, tl) {
  var q = encodeURIComponent(text);
  var clients = ['gtx', 'dict-chrome-ex'];
  var lastErr = null;

  function tryClient(idx) {
    if (idx >= clients.length) return Promise.reject(lastErr);
    var url = 'https://translate.googleapis.com/translate_a/single' +
              '?client=' + clients[idx] +
              '&sl=' + sl + '&tl=' + tl + '&dt=t&q=' + q;
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      return {
        text: d[0].map(function (s) { return s[0]; }).join(''),
        detected: d[2]
      };
    }).catch(function (e) {
      lastErr = e;
      return tryClient(idx + 1);
    });
  }
  return tryClient(0);
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

var log = [];
var firstCard = true;

function addCard(text, speaker, srcGuess) {
  if (!text || !text.trim()) return;
  if (firstCard) { feed.innerHTML = ''; firstCard = false; }

  var sl = srcGuess || src.value;
  var tl = tgt.value;
  var time = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  var card = document.createElement('div');
  card.className = 'card';

  var speakerTag = (speaker !== null && speaker !== undefined)
    ? '<span class="tag t3">Spk ' + escHtml(String(speaker + 1)) + '</span>'
    : '';

  card.innerHTML =
    '<div class="line">' +
      speakerTag +
      '<span class="tag t1 sl">' + escHtml(sl === 'auto' ? 'auto' : sl) + '</span>' +
      '<span class="s">' + escHtml(text) + '</span>' +
    '</div>' +
    '<hr>' +
    '<div class="line">' +
      '<span class="tag t2">' + escHtml(tl) + '</span>' +
      '<span class="d pend">translating\u2026</span>' +
    '</div>' +
    '<time>' + escHtml(time) + '</time>';

  feed.prepend(card);

  var out = card.querySelector('.d');
  var entry = { time: time, src: text, tr: null, from: sl, to: tl };
  log.push(entry);

  translate(text, sl, tl).then(function (r) {
    out.textContent = r.text;
    out.classList.remove('pend');
    entry.tr = r.text;
    if (sl === 'auto') {
      var slTag = card.querySelector('.sl');
      if (slTag && r.detected) slTag.textContent = r.detected;
    }
    speak(r.text, tl);
  }).catch(function (e) {
    out.textContent = 'Translation failed (' + e.message + '). Check your connection.';
    out.classList.remove('pend');
    out.style.color = 'var(--rec)';
  });
}

function speak(text, tl) {
  if (!sayToggle.checked) return;
  if (!('speechSynthesis' in window)) return;
  var meta = findLang(tl);
  var utter = new SpeechSynthesisUtterance(text);
  utter.lang = (meta && meta.sr) ? meta.sr : tl;
  speechSynthesis.speak(utter);
}

tbtn.addEventListener('click', function () {
  var v = txtInput.value;
  if (v && v.trim()) {
    addCard(v.trim(), null, 'auto');
    txtInput.value = '';
  }
});

txtInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') tbtn.click();
});

/* --- Audio visualizer --- */
var listening = false;
var ws = null;
var recorder = null;
var audioCtx = null;
var analyser = null;
var stream = null;
var rafId = null;
var sr = null;      /* SpeechRecognition instance */
var buf = '';
var bufSpk = null;

function drawMeter() {
  if (!analyser) return;
  var data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  var stride = Math.floor(data.length / bars.length) || 1;
  for (var i = 0; i < bars.length; i++) {
    var v = data[i * stride] || 0;
    bars[i].style.height = Math.max(4, (v / 255) * 48) + 'px';
  }
  rafId = requestAnimationFrame(drawMeter);
}

/* --- Deepgram streaming --- */
function dgUrl(lang) {
  var p = new URLSearchParams();
  var isMulti = lang.dg === 'multi';

  p.set('model', isMulti ? 'nova-3' : 'nova-2');
  p.set('smart_format', 'true');
  p.set('interim_results', 'true');
  p.set('endpointing', isMulti ? '100' : '300');
  p.set('punctuate', 'true');

  if (isMulti) {
    /* nova-3 multi: use detect_language, do NOT send language=multi */
    p.set('detect_language', 'true');
  } else {
    p.set('language', lang.dg);
  }

  if (diaToggle.checked) p.set('diarize', 'true');

  return 'wss://api.deepgram.com/v1/listen?' + p.toString();
}

function dominantSpeaker(alt) {
  if (!alt || !alt.words || !alt.words.length) return null;
  var counts = {};
  alt.words.forEach(function (w) {
    if (typeof w.speaker === 'number') {
      counts[w.speaker] = (counts[w.speaker] || 0) + 1;
    }
  });
  var keys = Object.keys(counts);
  if (!keys.length) return null;
  keys.sort(function (a, b) { return counts[b] - counts[a]; });
  return +keys[0];
}

function onDgMessage(ev) {
  var msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  var alt = msg && msg.channel && msg.channel.alternatives &&
            msg.channel.alternatives[0];
  if (!alt || !alt.transcript) return;

  var spk = dominantSpeaker(alt);

  if (msg.is_final) {
    /* Speaker changed mid-utterance: flush previous buffer */
    if (bufSpk !== null && spk !== null && spk !== bufSpk && buf.trim()) {
      addCard(buf.trim(), bufSpk);
      buf = '';
    }
    if (bufSpk === null && spk !== null) bufSpk = spk;
    buf = buf ? buf + ' ' + alt.transcript : alt.transcript;
    interim.textContent = buf;
  } else {
    interim.textContent = (buf ? buf + ' ' : '') + alt.transcript;
  }

  if (msg.speech_final && buf.trim()) {
    addCard(buf.trim(), bufSpk);
    buf = '';
    bufSpk = null;
    interim.textContent = '';
  }
}

function openDeepgram(lang, key) {
  ws = new WebSocket(dgUrl(lang), ['token', key]);
  var opened = false;

  ws.onopen = function () {
    opened = true;
    setStatus('listening \u00B7 Deepgram', true);
    var mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    if (!recorder || recorder.state === 'inactive') {
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = function (e) {
        if (e.data.size && ws.readyState === 1) {
          e.data.arrayBuffer().then(function (b) { ws.send(b); });
        }
      };
      recorder.start(250);
    }
  };

  ws.onmessage = onDgMessage;

  ws.onerror = function () {
    /* onclose will handle fallback */
  };

  ws.onclose = function
