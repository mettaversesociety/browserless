import { createWriteStream, existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path, { join } from 'path';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

import { deleteAsync } from 'del';
import unzip from 'extract-zip';
import { marked } from 'marked';
import { moveFile } from 'move-file';
import TJS from 'typescript-json-schema';

const swaggerJSONPath = path.join('static', 'docs', 'swagger.json');
const packageJSONPath = path.join('package.json');

const readFileOrNull = async (path: string | null) => {
  if (!path) {
    return 'null';
  }

  try {
    const content = await fs.readFile(path);
    return content.toString();
  } catch (e) {
    return 'null';
  }
};

export const generateSelectors = async () => {
  const { buildDir } = await import('./src/utils.js');
  const dataDir = path.join(buildDir, 'data');
  const selectorsURL =
    'https://raw.githubusercontent.com/wanhose/cookie-dialog-monster/main/data/elements.txt';
  const classesURL =
    'https://raw.githubusercontent.com/wanhose/cookie-dialog-monster/main/data/classes.txt';

  const get = async (url: string, type: string) => {
    try {
      const res = await fetch(url);
      const json = (await res.text()).split('\n');
      const filename = path.join(dataDir, `${type}.json`);
      await fs.writeFile(filename, JSON.stringify(json));
    } catch (e) {
      console.error(e);
    }
  };

  if (!existsSync(dataDir)) {
    await fs.mkdir(dataDir);
  }

  await Promise.all([
    get(selectorsURL, 'selectors'),
    get(classesURL, 'classes'),
  ]);
};

export const generateSchemas = async () => {
  const { getRouteFiles, tsExtension } = await import('./src/utils.js');

  const schemas = ['BodySchema', 'QuerySchema', 'ResponseSchema'];
  const settings = {
    ignoreErrors: true,
    noExtraProps: true,
    required: true,
  };

  const { compilerOptions } = JSON.parse(
    await fs.readFile('tsconfig.json', 'utf-8'),
  );

  const { Config } = await import('./src/config.js');
  const [httpRoutes, wsRoutes] = await getRouteFiles(new Config());
  await Promise.all(
    [...httpRoutes, ...wsRoutes]
      .filter((r) => r.endsWith(tsExtension))
      .map(async (route) => {
        const routeFile = (await fs.readFile(route)).toString('utf-8');
        if (!schemas.some((schemaName) => routeFile.includes(schemaName))) {
          return;
        }

        const program = TJS.getProgramFromFiles([route], compilerOptions, './');

        return Promise.all(
          schemas.map((schemaName) => {
            if (routeFile.includes(schemaName)) {
              const routePath = path.parse(route);
              const routeName = routePath.name.replace('.d', '');
              const schemaSuffix = schemaName
                .replace('Schema', '')
                .toLocaleLowerCase();
              routePath.base = `${routeName}.${schemaSuffix}.json`;
              const jsonPath = path.format(routePath);
              try {
                const schema = TJS.generateSchema(
                  program,
                  schemaName,
                  settings,
                );
                return fs.writeFile(
                  jsonPath,
                  JSON.stringify(schema, null, '  '),
                );
              } catch (e) {
                console.error(
                  `Error generating schema: (${routeName}) (${jsonPath}): ${e}`,
                );
                return null;
              }
            }
            return;
          }),
        );
      }),
  );
};

export const pullUblockOrigin = async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zipFile = os.tmpdir() + '/ublock.zip';
  const tmpUblockPath = path.join(os.tmpdir(), 'uBlock0.chromium'); // uBlock0.chromium is always the prod name
  const extensionsDir = join(__dirname, 'extensions');
  const uBlockDir = join(extensionsDir, 'ublock');

  const downloadUrlToDirectory = (url: string, dir: string) =>
    fetch(url).then(
      (response) =>
        new Promise((resolve, reject) => {
          // @ts-ignore
          Readable.fromWeb(response.body)
            .pipe(createWriteStream(dir))
            .on('error', reject)
            .on('finish', resolve);
        }),
    );

  if (existsSync(uBlockDir)) {
    await deleteAsync(uBlockDir);
  }
  const data = await fetch(
    'https://api.github.com/repos/gorhill/uBlock/releases/latest',
  );
  const json = await data.json();
  await downloadUrlToDirectory(json.assets[0].browser_download_url, zipFile);
  await unzip(zipFile, { dir: os.tmpdir() });
  await moveFile(join(tmpUblockPath), join(extensionsDir, 'ublock'));
  await deleteAsync(zipFile, { force: true }).catch((err) => {
    console.warn('Could not delete temporary download file: ' + err.message);
  });
};

interface Prop {
  name: string;
  required: boolean;
}

const sortSwaggerRequiredAlpha = (prop: Prop, otherProp: Prop) => {
  if (prop.required === otherProp.required) {
    if (prop.name < otherProp.name) {
      return -1;
    }
    if (prop.name > otherProp.name) {
      return 1;
    }
    return 0;
  }
  return Number(otherProp.required) - Number(prop.required);
};

export const generateOpenAPI = async () => {
  const [{ getRouteFiles }, { Config }, { errorCodes }, packageJSON] =
    await Promise.all([
      import('./src/utils.js'),
      import('./src/config.js'),
      import('./src/http.js'),
      fs.readFile(packageJSONPath),
    ]);

  const isWin = process.platform === 'win32';
  const readme = (await fs.readFile('README.md')).toString();
  const changelog = marked.parse(
    (await fs.readFile('CHANGELOG.md')).toString(),
  );
  const [httpRoutes, wsRoutes] = await getRouteFiles(new Config());
  const swaggerJSON = {
    customSiteTitle: 'Browserless Documentation',
    definitions: {},
    info: {
      description: readme + changelog,
      title: 'Browserless',
      version: JSON.parse(packageJSON.toString()).version,
      'x-logo': {
        altText: 'browserless logo',
        url: './docs/browserless-logo.png',
      },
    },
    openapi: '3.0.0',
    paths: {},
    servers: [],
    // Inject routes here...
  };

  const routeMetaData = await Promise.all(
    [...httpRoutes, ...wsRoutes]
      .filter((r) => r.endsWith('.js'))
      .sort()
      .map(async (routeModule) => {
        const routeImport = `${isWin ? 'file:///' : ''}${routeModule}`;
        const { default: route } = await import(routeImport);
        if (!route) {
          throw new Error(`Invalid route file to import docs ${routeModule}`);
        }
        const body = routeModule.replace('.js', '.body.json');
        const query = routeModule.replace('.js', '.query.json');
        const response = routeModule.replace('.js', '.response.json');
        const isWebSocket = routeModule.includes('/ws/');

        const {
          tags,
          description,
          auth,
          path,
          method,
          accepts,
          contentTypes,
          title,
        } = route;

        return {
          accepts,
          auth,
          body: isWebSocket ? null : JSON.parse(await readFileOrNull(body)),
          contentTypes,
          description,
          isWebSocket,
          method,
          path,
          query: JSON.parse(await readFileOrNull(query)),
          response: isWebSocket
            ? null
            : JSON.parse(await readFileOrNull(response)),
          tags,
          title,
        };
      }),
  );

  const paths = routeMetaData.reduce((accum, r) => {
    const swaggerRoute = {
      definitions: {} as { [key: string]: unknown },
      description: r.description,
      parameters: [] as Array<unknown>,
      requestBody: {
        content: {} as { [key: string]: unknown },
      },
      responses: {
        ...errorCodes,
      } as { [key: string]: unknown },
      summary: r.path,
      tags: r.tags,
    };

    r.method = r.isWebSocket ? 'get' : r.method;

    // Find all the swagger definitions and merge them into the
    // definitions object
    const allDefs = {
      ...(r?.body?.definitions || {}),
      ...(r?.query?.definitions || {}),
      ...(r?.response?.definitions || {}),
    };

    Object.entries(allDefs).forEach(([defName, definition]) => {
      // @ts-ignore
      swaggerJSON.definitions[defName] =
        // @ts-ignore
        swaggerJSON.definitions[defName] ?? definition;
    });

    if (r.isWebSocket) {
      swaggerRoute.responses['101'] = {
        description: 'Indicates successful WebSocket upgrade.',
      };
    }

    // Does a best-attempt at configuring multiple response types
    // Won't figure out APIs that return mixed response types like
    // JSON and binary blobs
    if (r.response) {
      if (r.contentTypes.length === 1) {
        const [type] = r.contentTypes;
        swaggerRoute.responses['200'] = {
          content: {
            [type]: {
              schema: r.response,
            },
          },
          description: r.response.description,
        };
      } else {
        const okResponses = r.contentTypes.reduce(
          (accum: object, c: string) => {
            // @ts-ignore
            accum.content[c] = {
              schema: {
                type: 'text',
              },
            };
            return accum;
          },
          {
            content: {},
            description: r.response.description,
          },
        );
        swaggerRoute.responses['200'] = okResponses;
      }
    }

    // Does a best-attempt at configuring multiple body types and
    // ignores the "accepts" properties on routes since we can't
    // yet correlate the accepted types to the proper body
    if (r.body) {
      const { properties, type, anyOf } = r.body;
      if (anyOf) {
        // @ts-ignore
        anyOf.forEach((anyType) => {
          if (anyType.type === 'string') {
            const type = r.accepts.filter(
              // @ts-ignore
              (accept) => accept !== 'application/json',
            );
            swaggerRoute.requestBody.content[type] = {
              schema: {
                type: 'string',
              },
            };
          }

          if (anyType['$ref']) {
            swaggerRoute.requestBody.content['application/json'] = {
              schema: {
                $ref: anyType['$ref'],
              },
            };
          }
        });
      }

      // Handle JSON
      if (type === 'object') {
        swaggerRoute.requestBody.content['application/json'] = {
          schema: {
            properties,
            type: 'object',
          },
        };
      }
    }

    // Queries are easy in comparison, but still have to be iterated
    // over and made open-api-able
    if (r.query) {
      const { properties, required } = r.query;
      const props = Object.keys(properties || {});
      if (props.length) {
        swaggerRoute.parameters = props
          .map((prop) => ({
            in: 'query',
            name: prop,
            required: required?.includes(prop),
            schema: properties[prop],
          }))
          .sort(sortSwaggerRequiredAlpha);
      }
    }

    // @ts-ignore
    accum[r.path] = accum[r.path] || {};
    // @ts-ignore
    accum[r.path][r.method] = swaggerRoute;

    return accum;
  }, {});
  swaggerJSON.paths = paths;

  fs.writeFile(swaggerJSONPath, JSON.stringify(swaggerJSON, null, '  '));
};
