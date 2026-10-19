# GXS Mockup QA

Proyecto Playwright/TypeScript para generar y validar mockups únicamente en GraphXServer DEV. Las iteraciones son secuenciales. El modo predeterminado es dry-run y no envía solicitudes de generación.

## Preparación en PowerShell

Requisitos: Node.js 20+, cuenta QA autorizada y acceso al entorno DEV.

```powershell
pnpm install
pnpm exec playwright install chromium
Copy-Item .env.example .env
code .env
```

Completa `GXS_EMAIL` y `GXS_PASSWORD` en `.env` local. Mantén `GXS_EXECUTION_MODE=dry-run` y `GXS_MAX_ORDERS=1`. No compartas `.env` ni `config/auth.json`; ambos están excluidos de Git. Los errores y reportes no imprimen credenciales.

## Comandos

```powershell
npm run auth
npm run inspect
npm run validate
npm run test:dry
npm run test:submit
npm run test:selection
```

`auth` usa el formulario real y guarda `config/auth.json`. Las demás ejecuciones reutilizan la sesión y la renuevan si DEV redirige al login. CAPTCHA, MFA y otros retos interactivos detienen la automatización; no se intentan omitir.

`inspect` abre Mockups con el estado guardado. `test:dry` recorre cada combinación configurada, verifica el formato y los valores serializados de dimensiones en Summary, y no pulsa Generate.

`test:submit` selecciona modo live y falla cerrado si falta cualquier aprobación. Para la prueba controlada de una orden, después de un dry-run satisfactorio:

```powershell
$env:GXS_MAX_ORDERS='1'
$env:ALLOW_SUBMIT='true'
$env:APPROVE_SUBMISSIONS='true'
$env:SELECTORS_VERIFIED='true'
npm run test:submit
Remove-Item Env:GXS_MAX_ORDERS, Env:ALLOW_SUBMIT, Env:APPROVE_SUBMISSIONS, Env:SELECTORS_VERIFIED
```

Live requiere explícitamente un máximo entero, `ALLOW_SUBMIT=true`, `APPROVE_SUBMISSIONS=true` y `SELECTORS_VERIFIED=true`. La configuración actual limita `maxSubmissions` a 1; ampliar un batch requiere cambiar ese límite y aprobarlo con `APPROVE_MULTIPLE_SUBMISSIONS=true`. Si Generate se pulsa pero no se captura un Order ID, el resultado queda incierto, el test se detiene y no reintenta.

## Selección y ejecución

Edita `config/cases.json`. `catalogProducts` debe contener productos reales del catálogo en el orden deseado; `selectionMode` acepta `sequential`, `random` o `targeted`; `targetSkus` configura el modo targeted; `selectionSeed` reproduce el orden aleatorio. El picker comprueba cada SKU en la UI real. No se repiten SKUs salvo que `allowDuplicateSkus` sea `true`.

`productDecorations` configura ubicación y artwork por SKU. `dimensionStepsPx` y `formatSteps` deben tener una entrada por iteración (`repetitions`); el test combina cada producto, formato y dimensión en el mismo índice. Los formatos admitidos son PNG, WEBP y PDF, y el test falla si uno no aparece en el menú real del producto. La interfaz actual vincula ancho/alto; solo se permiten dimensiones cuadradas verificadas en píxeles.

## Evidencia y límites actuales

`reports/mockup-results.csv` registra producto, ubicación, formato, dimensiones solicitadas/verificadas, Order ID, resultado de envío, estado de generación, duración, error, screenshot y timestamp. Las columnas de salida registran formato detectado, píxeles o dimensiones PDF en puntos. Si la orden llega a Completed, el test descarga el archivo y valida su formato; PNG/WEBP deben coincidir con los píxeles solicitados y PDF debe abrirse y tener página. `requestHttpStatus` queda como `Not captured`; HTTP 200 no se considera generación completada. Las filas históricas se migran conservando sus datos y dejando vacías las dimensiones que antes no se verificaron. Screenshots, video y trace se guardan en fallos.

El entorno está fijado a `https://dev.beta.graphxserver.io`; Staging/Production no pasan la validación. La prueba controlada inicial usa un producto real configurado, PNG y 3000 px para no repetir el pedido anterior de 2000 px que continúa en Created. El resto de formatos/tamaños se valida en dry-run; no se ejecuta ningún batch mayor de una orden sin aprobación posterior.