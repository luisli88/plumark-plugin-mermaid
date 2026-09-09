import hljs from "highlight.js/lib/core";
import mermaid from "mermaid";
// `--loader:.css=text` (ver package.json `build`) da el contenido crudo del
// CSS como string — mismo mecanismo que usa `markdown-editor-plugin-katex`
// para su propio `katex/dist/katex.min.css`.
import svgStyles from "./styles.css";
import editorStyles from "./editor-styles.css";

// Plugin de primera parte (research.md R4/R9) — mismo contrato exacto que
// cualquier plugin de terceros (contracts/plugin-contract.md), sin camino de
// código especial. Se empaqueta (bundlea) con la librería `mermaid` incluida
// para que el sandbox nunca necesite red al ejecutarlo (FR-024).

/**
 * Mismo shape que `PluginThemeContext` de `@plumark/plugin-sdk` — no
 * se declara como dependencia de npm (ese paquete es privado al monorepo,
 * sin publicar); el contrato completo está documentado en el `README.md` de
 * `plugin-sdk` (github.com/luisli88/PluMark).
 */
interface PluginThemeContext {
  mode: "light" | "dark";
  background: string;
  surface: string;
  surfaceMuted: string;
  text: string;
  textMuted: string;
  border: string;
  accent: string;
}

/** Mismo shape que `SyntaxGrammar` de `@plumark/plugin-sdk` — ver nota de `PluginThemeContext` arriba sobre por qué no se importa el paquete. */
interface SyntaxGrammar {
  caseInsensitive?: boolean;
  keywords?: Record<string, string>;
  comment?: { begin: string; end: string };
  quoteStrings?: boolean;
  contains?: Array<{ className: string; begin: string; end?: string }>;
}

// Paleta de marca ("Ideas El Gato Sin Botas" v1.0.0 — design/design-reference.md)
// en vez del morado por defecto de Mermaid — fallback usado solo cuando
// `render()` no recibe `theme` (host sin theming, o una primera llamada
// antes de que exista un tema activo).
//
// Sin `fontFamily` a propósito (revisado tras pruebas de usuario: texto
// cortado en las tablas de ER diagram) — Mermaid mide el texto para calcular
// cajas DENTRO de este mismo sandbox (CSP `default-src 'none'`, sin fuentes
// externas), pero el SVG se pinta después en la página principal, que sí
// puede tener otra fuente disponible. Pedir una fuente que el sandbox no
// puede cargar hace que la medición (sandbox) y el pintado (página
// principal) usen anchos distintos, y el texto termina desbordando su caja.
// Sin este campo, cae al default de Mermaid
// (`"trebuchet ms", verdana, arial, sans-serif`), disponible en ambos lados.
// `htmlLabels: false` (default de Mermaid es `true`) — con `true`, cada
// etiqueta de texto se emite como `<foreignObject><div>...</div></foreignObject>`
// dentro del SVG. El host (`plugin-block-view.tsx`/`diagram-edit-mode.ts`)
// sanitiza el `render()` de cualquier plugin con DOMPurify antes de
// insertarlo en su propio documento — DOMPurify vacía el contenido de
// `foreignObject` por diseño (protección deliberada contra un vector de XSS
// conocido, sin override seguro), así que con `htmlLabels: true` el texto de
// cada etiqueta desaparecería. `false` hace que Mermaid emita `<text>`/`<tspan>`
// SVG nativo en su lugar, que DOMPurify preserva sin problema.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  themeVariables: {
    primaryColor: "#F0F2FA",
    primaryTextColor: "#0F1520",
    primaryBorderColor: "#334A99",
    lineColor: "#64718A",
    secondaryColor: "#ECF0F8",
    tertiaryColor: "#F8F9FC",
  },
});

let renderCount = 0;

/**
 * Mermaid's "base" theme (`theme-base.js`, `updateColors()`) computes its
 * mindmap section palette (`cScale0`-`cScale11`) and gitGraph branch palette
 * (`git0`-`git7`) by hue-rotating `primaryColor`, then UNCONDITIONALLY darkens
 * every one of those slots by 25% (light mode) or 75% (dark mode) — a no-op
 * against its own light pastel defaults, but devastating against an
 * already-dark `theme.surface`: every mindmap section/gitGraph branch renders
 * near-black regardless of what theme is active (observed: a mindmap in dark
 * mode showed solid black boxes for every node). `mermaidAPI`'s
 * `calculate(overrides)` re-applies the override object a SECOND time right
 * after computing all of this, for exactly the keys present in it — so
 * setting these slots explicitly (below) survives the auto-darken pass
 * instead of feeding it.
 */
const MINDMAP_SECTION_COUNT = 12; // cScale0-11 — matches Theme.THEME_COLOR_LIMIT / mindmap's MAX_SECTIONS.
const GITGRAPH_BRANCH_COUNT = 8; // git0-7 — matches Theme's own git branch palette size.

// -- Paleta categórica para mindmap/gitGraph --------------------------------
//
// La primera versión de este mapeo alternaba `surface`/`surfaceMuted` para
// estos slots (siguen usándose para todo lo demás, ver `themeVariablesFrom`)
// — dos tonos de "elevación de card" pensados para diferenciarse apenas del
// fondo, no para servir de paleta categórica. Contra un `background` oscuro
// (`theme.surface`/`surfaceMuted` de un tema oscuro típico son solo un poco
// más claros que `background`), el resultado reportado por Luis fue el mismo
// bug de siempre en otra forma: cajas de mindmap y ramas de gitGraph casi
// invisibles contra la página, y sin poder distinguir una rama/sección de la
// de al lado (ambas cayendo en el mismo tono alternado).
//
// La paleta de abajo reusa los 8 tonos categóricos ya validados del propio
// sistema de diseño (dataviz skill, `references/palette.md`: separación CVD
// adjacente >=8 ΔE OKLab en ambos modos) — cada tono trae un paso "claro" y
// uno "oscuro" ya probados contra las superficies de referencia del sistema.
// `theme.mode` decide qué columna usar (los 8 pasos de una misma columna
// mantienen entre sí la banda de luminosidad que el validador exige — mezclar
// columnas por slot, aunque cada mezcla individual contrastara bien, dejaba
// slots visiblemente más claros que sus vecinos). El paso de la OTRA columna
// solo entra como red de emergencia si el de la columna activa no llega ni a
// 3:1 contra `theme.background` — que puede ser cualquier tema instalado por
// el usuario (ej. uno importado de VS Code), no solo los presets propios de
// la app. El texto/ícono DENTRO de cada sección (`cScaleLabel*`) se resuelve
// aparte: negro o blanco casi puro, el que más contraste dé contra el
// relleno ya elegido — nunca `theme.text` a ciegas, que podía terminar siendo
// texto claro sobre un relleno igual de claro.
const WCAG_MIN_FILL_CONTRAST = 3; // mismo piso que usa el validador del propio sistema de diseño.
const NEAR_BLACK_INK = '#0a0a0a';
const NEAR_WHITE_INK = '#fafafa';

/** sRGB (0-1 por canal) desde un hex de 6 dígitos. */
function hexToSrgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) / 255);
  return [r!, g!, b!];
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Luminancia relativa WCAG — misma fórmula que usa el validador de paletas del sistema de diseño. */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToSrgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ratio de contraste WCAG (1-21) entre dos colores, sin importar el orden. */
function contrastRatio(hexA: string, hexB: string): number {
  const [high, low] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}

/**
 * Ocho familias de matiz en orden fijo (canal de identidad — nunca se ciclan
 * para una 9na serie *estadística*; acá se reciclan del slot 0 en adelante
 * recién a partir de la sección 8 de un mindmap, ver el loop de abajo, porque
 * un mindmap con más de 8 ramas de nivel superior es raro y "dos ramas lejanas
 * comparten tono" es un compromiso menor comparado con el bug actual). Pasos
 * claro/oscuro reusados tal cual del validador de paletas del sistema de
 * diseño (dataviz skill) — separación CVD adjacente ya probada en ambos modos.
 */
const CATEGORICAL_HUES: ReadonlyArray<{ light: string; dark: string }> = [
  { light: '#2a78d6', dark: '#3987e5' }, // azul
  { light: '#eb6834', dark: '#d95926' }, // naranja
  { light: '#1baf7a', dark: '#199e70' }, // aqua
  { light: '#eda100', dark: '#c98500' }, // amarillo
  { light: '#e87ba4', dark: '#d55181' }, // magenta
  { light: '#008300', dark: '#008300' }, // verde
  { light: '#4a3aa7', dark: '#9085e9' }, // violeta
  { light: '#e34948', dark: '#e66767' }, // rojo
];

/**
 * El paso de este matiz para el modo activo — el mismo `theme.mode` decide
 * TODOS los slots a la vez (nunca uno de cada columna: eso rompía la banda de
 * luminosidad consistente que el propio validador de paletas exige entre
 * pares — un slot inusualmente claro al lado de otros medios se lee
 * "descolorido" frente al resto). El otro paso queda como red de emergencia
 * exclusivamente para el caso borde en que el paso del modo activo no llegue
 * ni a 3:1 contra el fondo real (ej. un tema oscuro importado con un fondo
 * poco oscuro) — active solo entonces, nunca por preferencia de contraste.
 */
function bestFillFor(
  hue: { light: string; dark: string },
  mode: PluginThemeContext['mode'],
  background: string,
): string {
  const preferred = mode === 'dark' ? hue.dark : hue.light;
  const fallback = mode === 'dark' ? hue.light : hue.dark;
  return contrastRatio(preferred, background) >= WCAG_MIN_FILL_CONTRAST ? preferred : fallback;
}

/** Negro o blanco casi puro, el que más contraste dé para texto sobre este relleno puntual. */
function inkFor(fill: string): string {
  return contrastRatio(NEAR_BLACK_INK, fill) >= contrastRatio(NEAR_WHITE_INK, fill)
    ? NEAR_BLACK_INK
    : NEAR_WHITE_INK;
}

/**
 * Mapea los 8 slots genéricos de `PluginThemeContext` a los `themeVariables`
 * propios de Mermaid.
 *
 * `background` (revisado tras pruebas de usuario: texto de ejes/títulos
 * ilegible en diagramas XY chart/gitGraph/journey con temas oscuros) es una
 * variable de Mermaid separada de `primaryColor`/`tertiaryColor` — varios
 * tipos de diagrama (`xyChart.backgroundColor`, fondos de sección en
 * gitGraph/journey) caen a ella, no a las de arriba, así que sin
 * sobreescribirla quedaba fija en el gris claro por defecto de Mermaid
 * (`#f4f4f4`) sin importar el tema.
 *
 * `rowOdd`/`rowEven` (ER diagram, filas de atributos de cada entidad —
 * verificado leyendo el propio código fuente de `mermaid` instalado, no
 * documentación: la variable real en esta versión es esta, `mermaid` no
 * `attributeBackgroundColorOdd`/`Even` como asumía una versión anterior de
 * este mapeo. Esa pareja de nombres quedó muerta — nunca tocaba nada, así
 * que las filas caían al `rowOdd`/`rowEven` DEFAULT de Mermaid, sin relación
 * con el tema activo — que explica el bug reportado: el texto de cada
 * atributo usa un único color fijo (`textColor`) para las 2 filas
 * alternadas, así que ambas necesitan quedar del lado correcto de ESE color,
 * no solo diferenciarse entre sí. `surface`/`surfaceMuted` (los mismos dos
 * tonos "de card" que la app ya da por seguros contra `text` en todo el
 * resto de la UI, ver el `sidebarBg`/`bgCard` que los originan) cumplen
 * justo eso — a diferencia de la paleta categórica de mindmap/gitGraph de
 * abajo, acá SÍ corresponde alternar dos tonos de superficie: nunca hay más
 * de 2 filas visibles a la vez por la alternancia par/impar, así que no hace
 * falta distinguir N vecinos entre sí, solo mantener el mismo texto legible
 * en ambas.
 *
 * `cScale*`/`git*` (mindmap sections, gitGraph branches): ver el comentario de
 * "Paleta categórica" arriba — `bestFillFor()`/`inkFor()` reemplazan el
 * alternado `surface`/`surfaceMuted` de antes. `cScaleInv`/`gitInv` (trazo de
 * los conectores) siguen yendo a `text` (antes `border`: mismo motivo — con la
 * paleta nueva conviene el color de texto normal, ya garantizado legible
 * contra `background` en cualquier tema bien formado, en vez de un borde
 * pensado para líneas divisorias sutiles) en vez de heredar el `invert()` que
 * Mermaid calcularía sobre el valor YA oscurecido (ese cálculo corre antes de
 * que el override de abajo lo pueda pisar).
 */
function themeVariablesFrom(theme: PluginThemeContext): Record<string, string> {
  const variables: Record<string, string> = {
    background: theme.background,
    primaryColor: theme.surface,
    primaryTextColor: theme.text,
    primaryBorderColor: theme.accent,
    lineColor: theme.textMuted,
    secondaryColor: theme.surfaceMuted,
    tertiaryColor: theme.background,
    rowOdd: theme.surface,
    rowEven: theme.surfaceMuted,
  };

  const fills = CATEGORICAL_HUES.map((hue) => bestFillFor(hue, theme.mode, theme.background));

  for (let i = 0; i < MINDMAP_SECTION_COUNT; i++) {
    const fill = fills[i % fills.length]!;
    variables[`cScale${i}`] = fill;
    variables[`cScaleLabel${i}`] = inkFor(fill);
    variables[`cScaleInv${i}`] = theme.text;
  }
  for (let i = 0; i < GITGRAPH_BRANCH_COUNT; i++) {
    const fill = fills[i]!;
    variables[`git${i}`] = fill;
    variables[`gitBranchLabel${i}`] = inkFor(fill);
    variables[`gitInv${i}`] = theme.border;
  }
  return variables;
}

/**
 * Cualquier `%%{init}%%`/`%%{initialize}%%` que el propio `source` del
 * diagrama traiga (ej. una nota de referencia de sintaxis Mermaid que lo
 * incluye como EJEMPLO de contenido — caso real observado) se neutraliza
 * antes de renderizar: el tema de la app, aplicado abajo vía
 * `mermaid.initialize()`, debe ganar siempre para mantenerse "congruente por
 * construcción" con el resto de la app — nunca un directive suelto que
 * traiga el contenido del diagrama.
 */
const INIT_DIRECTIVE_PATTERN = /%%\{\s*init(?:ialize)?\s*:[\s\S]*?\}%%/g;

function stripInitDirectives(source: string): string {
  return source.replace(INIT_DIRECTIVE_PATTERN, "");
}

/**
 * `styles.css` — el host la inyecta como un `<style>` propio, aparte del
 * HTML que devuelve `render()` (nunca mezclada en ese string), dentro del
 * shadow root donde monta este plugin.
 */
function getStylesheet(): string {
  return svgStyles;
}

async function render(source: string, theme?: PluginThemeContext): Promise<string> {
  if (theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      htmlLabels: false,
      themeVariables: themeVariablesFrom(theme),
    });
  }
  const { svg } = await mermaid.render(
    `mermaid-diagram-${++renderCount}`,
    stripInitDirectives(source),
  );
  return svg;
}

/** Mismo shape que `PluginEditorSession` de `@plumark/plugin-sdk` — ver nota de `PluginThemeContext` arriba sobre por qué no se importa el paquete. */
interface PluginEditorSession {
  destroy(): void;
}

/** Mismo shape que `PluginEditorMountOptions` de `@plumark/plugin-sdk`. */
interface PluginEditorMountOptions {
  container: HTMLElement;
  initialSource: string;
  theme?: PluginThemeContext;
  onCommit: (newSource: string) => void;
}

const EDITOR_DEBOUNCE_MS = 300;

/**
 * Gramática de resaltado propia (antes vivía a mano dentro del monorepo host,
 * en `document-core/src/syntax/mermaid.ts` — movida acá para que agregar un
 * lenguaje nuevo de plugin no requiera tocar el core del editor). Cubre las
 * palabras clave propias de cada tipo de diagrama que Mermaid soporta
 * (flowchart, sequence, class, state, ER, gantt, pie, journey, gitGraph,
 * mindmap, timeline, quadrant, requirement, C4), directivas comunes
 * (`click`/`style`/`classDef`/`linkStyle`), números/duraciones, y las
 * variantes de flecha/relación de cada diagrama (conectores de flowchart,
 * mensajes de secuencia, relaciones de clase) — no un parser Mermaid
 * completo (eso solo lo tiene el propio Mermaid), pero sí una cobertura real
 * de lo que aparece en la práctica.
 */
const syntaxGrammar: SyntaxGrammar = {
  keywords: {
    keyword:
      // Declaración de tipo de diagrama.
      "graph flowchart flowchart-elk sequenceDiagram classDiagram classDiagram-v2 " +
      "stateDiagram stateDiagram-v2 erDiagram gantt pie journey gitGraph mindmap " +
      "quadrantChart timeline requirementDiagram sankey-beta xychart-beta " +
      "block-beta packet-beta C4Context C4Container C4Component C4Dynamic C4Deployment " +
      // Flowchart.
      "subgraph end direction " +
      // Sequence diagram.
      "participant actor activate deactivate note over left right of loop alt " +
      "else opt par and critical option break rect autonumber box create destroy " +
      "links properties details " +
      // Class diagram / state diagram.
      "class interface namespace state as hide empty description " +
      // ER diagram.
      "one-or-zero one-or-many zero-or-more zero-or-one only " +
      // Gantt.
      "dateFormat axisFormat includes excludes todayMarker tickInterval weekday " +
      "section done active crit milestone after before " +
      // Pie / journey / timeline / quadrant.
      "showData x-axis y-axis quadrant-1 quadrant-2 quadrant-3 quadrant-4 " +
      // GitGraph.
      "commit branch checkout merge cherry-pick tag reset order type id parent " +
      // Directivas comunes a varios diagramas.
      "title click link style classDef linkStyle callback cssClass",
    literal: "TD TB LR RL BT true false",
  },
  comment: { begin: "%%", end: "$" },
  quoteStrings: true,
  contains: [
    {
      // Conectores/flechas de flowchart y mensajes de sequenceDiagram — el
      // mismo campo semántico que un operador en un lenguaje de programación.
      className: "operator",
      begin:
        "(<?-{1,2}\\.{1,2}->>?|<?={2,3}>|-{1,2}>>|--?>>|<-{1,2}>|--[ox]|\\.\\.>|-{2,3}>|-{2,3}(?!>)|-x|--x|-\\)|--\\)|" +
        // Relaciones de classDiagram: herencia/composición/agregación/realización.
        "<\\|--|--\\|>|\\*--|--\\*|o--|--o|\\.\\.\\|>|<\\|\\.\\.|\\.\\.>|<\\.\\.)",
    },
    {
      // Etiqueta de nodo/arista entre corchetes/paréntesis/llaves — ej.
      // `A[Inicio]`, `B(Proceso)`, `C{Decisión}`.
      className: "title",
      begin: "[[({][^\\]})]*[\\])}]",
    },
    {
      // Etiqueta de arista sin comillas — ej. `A -->|etiqueta| B`.
      className: "string",
      begin: "\\|[^|\\n]*\\|",
    },
    {
      // Números y duraciones (gantt: `5d`, `2w`; fechas: `2024-01-01`;
      // porcentajes de pie).
      className: "number",
      begin: "\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d+(\\.\\d+)?[dwmy]?%?\\b",
    },
  ],
};

function getSyntaxGrammar(): SyntaxGrammar {
  return syntaxGrammar;
}

/**
 * Traduce `syntaxGrammar` (datos serializables, `getSyntaxGrammar()`) a la
 * función `(hljs) => Language` real que `highlight.js` necesita — mismo
 * mecanismo que usa el host para cualquier plugin (`translateGrammar`,
 * `document-core/src/syntax-highlighting.ts`), reimplementado acá porque el
 * overlay de resaltado de `mountEditor()` (más abajo) corre DENTRO de este
 * sandbox, nunca en el host, así que no puede reusar esa función.
 */
hljs.registerLanguage("mermaid", (hljsInstance) => ({
  case_insensitive: syntaxGrammar.caseInsensitive ?? false,
  ...(syntaxGrammar.keywords ? { keywords: syntaxGrammar.keywords } : {}),
  contains: [
    ...(syntaxGrammar.comment
      ? [hljsInstance.COMMENT(syntaxGrammar.comment.begin, syntaxGrammar.comment.end)]
      : []),
    ...(syntaxGrammar.quoteStrings ? [hljsInstance.QUOTE_STRING_MODE] : []),
    ...(syntaxGrammar.contains ?? []).map((rule) => ({
      className: rule.className,
      begin: new RegExp(rule.begin),
      ...(rule.end ? { end: new RegExp(rule.end) } : {}),
    })),
  ],
}));

const HTML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

/** Overlay de resaltado del editor propio — mismo `hljs.highlight()` que usa el host, misma técnica de `<pre><code>` detrás de un `<textarea>` con texto transparente (`diagram-edit-mode.ts`, host, para el editor genérico). */
function highlightSourceToHtml(source: string): string {
  return `${hljs.highlight(source, { language: "mermaid" }).value}\n`;
}

/**
 * v1 de `mountEditor` — reproduce el layout del editor genérico del host
 * (split apilado, código arriba/preview debajo, mismo debounce/atajos de
 * commit: Escape/Cmd+Enter/blur confirman, Tab inserta un tab real), ahora
 * dueño de su propio DOM/CSS dentro de este sandbox en vez del `editor.css`
 * del host.
 *
 * Con overlay de resaltado propio (`highlightSourceToHtml`, arriba) — mismo
 * `<pre><code>` detrás de un `<textarea>` de texto transparente que usa el
 * editor genérico del host (`diagram-edit-mode.ts`), pero con la propia
 * gramática/paleta del plugin en vez de depender de tokens que
 * `PluginThemeContext` no expone (son detalle del chrome del host, no del
 * tema).
 */
function mountEditor(options: PluginEditorMountOptions): PluginEditorSession {
  const theme = options.theme;

  const style = document.createElement("style");
  style.textContent = editorStyles;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.className = "mermaid-edit-mode";
  // `editor-styles.css` referencia estas custom properties en vez de
  // colores fijos — es la única parte de la hoja que depende de `theme`
  // (recibido en runtime, no algo que un archivo `.css` estático pueda
  // tener adentro), así que viaja aparte, seteada acá en vez de
  // interpolada dentro del CSS.
  root.style.setProperty("--mermaid-editor-surface", theme?.surface ?? "#f0f2fa");
  root.style.setProperty("--mermaid-editor-surface-muted", theme?.surfaceMuted ?? "#ecf0f8");
  root.style.setProperty("--mermaid-editor-text", theme?.text ?? "#0f1520");
  root.style.setProperty("--mermaid-editor-border", theme?.border ?? "#334a99");

  const codePane = document.createElement("div");
  codePane.className = "mermaid-edit-code-pane";

  const highlightPre = document.createElement("pre");
  highlightPre.className = "mermaid-edit-highlight";
  highlightPre.setAttribute("aria-hidden", "true");
  const highlightCode = document.createElement("code");
  highlightPre.appendChild(highlightCode);

  const textarea = document.createElement("textarea");
  textarea.className = "mermaid-edit-textarea";
  textarea.value = options.initialSource;
  textarea.spellcheck = false;
  // `autofocus` (atributo declarativo) en vez de solo `textarea.focus()`
  // imperativo: este `mountEditor()` corre recién después de un round-trip
  // async (mensaje "mount" del host + `import()` de este módulo desde un
  // blob), fuera de cualquier gesto de usuario síncrono — verificado que
  // WebKit, dentro de un iframe sandboxeado, bloquea en silencio un
  // `element.focus()` disparado ahí (activeElement se quedaba en `<body>`
  // pese a que el iframe SÍ tenía foco de ventana). `autofocus` es un
  // mecanismo distinto: lo procesa el propio navegador al insertar el nodo,
  // no gateado detrás de "hay un gesto de usuario corriendo ahora" — solo
  // requiere el permiso de Permissions Policy (`allow="autofocus"` en el
  // `<iframe>`, ver `plugin-editor-sandbox.ts`).
  textarea.autofocus = true;
  codePane.append(highlightPre, textarea);

  const previewPane = document.createElement("div");
  previewPane.className = "mermaid-edit-preview-pane";

  root.append(codePane, previewPane);
  options.container.appendChild(root);
  // Redundante junto con `autofocus` de arriba (no debería hacer falta si
  // ese mecanismo aplica), pero sin costo si ya está enfocado — cubre
  // cualquier caso donde `autofocus` no re-dispare por algún motivo.
  textarea.focus();

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let renderToken = 0;

  function renderPreview(source: string): void {
    const currentToken = ++renderToken;
    render(source, theme)
      .then((svg) => {
        if (currentToken !== renderToken) return;
        previewPane.classList.remove("error");
        previewPane.innerHTML = svg;
      })
      .catch((error: unknown) => {
        if (currentToken !== renderToken) return;
        previewPane.classList.add("error");
        previewPane.innerHTML = "";
        const panel = document.createElement("div");
        panel.className = "mermaid-edit-error-panel";
        panel.textContent = error instanceof Error ? error.message : String(error);
        previewPane.appendChild(panel);
      });
  }

  function updateHighlight(source: string): void {
    highlightCode.innerHTML = highlightSourceToHtml(source);
  }

  function syncHighlightScroll(): void {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  }

  function scheduleRender(): void {
    updateHighlight(textarea.value);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderPreview(textarea.value), EDITOR_DEBOUNCE_MS);
  }

  renderPreview(options.initialSource);
  updateHighlight(options.initialSource);
  textarea.addEventListener("input", scheduleRender);
  textarea.addEventListener("scroll", syncHighlightScroll);

  function commit(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    options.onCommit(textarea.value);
  }

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      commit();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = textarea;
      textarea.value = `${value.slice(0, selectionStart)}\t${value.slice(selectionEnd)}`;
      textarea.selectionStart = selectionStart + 1;
      textarea.selectionEnd = selectionStart + 1;
      scheduleRender();
    }
  });
  textarea.addEventListener("blur", commit);

  return {
    destroy(): void {
      if (debounceTimer) clearTimeout(debounceTimer);
    },
  };
}

/**
 * §7 diseño de contribuciones de plugin: ítem del menú/toolbar nativo
 * "Insertar" — inserta un bloque nuevo después del actual con esta plantilla
 * mínima en vez de arrancar vacío (un flowchart vacío no renderiza nada útil
 * como primer vistazo). `icon`: nombre de SF Symbol que el host usa para el
 * botón (`@plumark/plugin-sdk`) — un diagrama de torta es la
 * metáfora visual más reconocible para "diagrama" en el set de símbolos de
 * Apple.
 */
function getInsertMenuItem(): { label: string; defaultSource: string; icon: string } {
  return { label: "Diagrama", defaultSource: "graph TD;\n    A --> B;\n", icon: "chart.pie" };
}

/** US8/FR-022: representaciones de exportación que este plugin ofrece — el panel de exportación las descubre dinámicamente (`export-panel.ts`). */
function getExportRepresentations(): Array<{ id: string; label: string }> {
  return [
    { id: "embedded", label: "Imagen embebida" },
    { id: "as-is", label: "Markdown tal cual" },
  ];
}

/** `"as-is"`: sin imagen — conserva el `source` tal cual en el Markdown exportado (FR-022). Cualquier otro valor (incluido `undefined`, plugins de terceros anteriores a US8) usa el comportamiento `"embedded"` ya existente. */
async function exportDiagram(
  source: string,
  representationId?: string,
): Promise<{ svg?: string; verbatim?: boolean }> {
  if (representationId === "as-is") return { verbatim: true };
  return { svg: await render(source) };
}

export default {
  render,
  export: exportDiagram,
  getExportRepresentations,
  getSyntaxGrammar,
  getInsertMenuItem,
  mountEditor,
  getStylesheet,
};
