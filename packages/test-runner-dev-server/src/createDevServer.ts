import { Server, SESSION_STATUS } from '@web/test-runner-core';
import { createConfig, startServer, Config } from 'es-dev-server';
import deepmerge from 'deepmerge';
import { Context, Next } from 'koa';
import net from 'net';
import path from 'path';
import parse from 'co-body';
import chokidar from 'chokidar';
import { dependencyGraphMiddleware } from './dependencyGraphMiddleware';
import { createTestPage } from './createTestPage';
import { toBrowserPath } from './utils';

export { Config as DevServerConfig };

function createBrowserFilePath(rootDir: string, filePath: string) {
  const fullFilePath = filePath.startsWith(process.cwd())
    ? filePath
    : path.join(process.cwd(), filePath);
  const relativeToRootDir = path.relative(rootDir, fullFilePath);
  return toBrowserPath(relativeToRootDir);
}

export function createDevServer(devServerConfig: Partial<Config> = {}): Server {
  const rootDir = devServerConfig.rootDir ? path.resolve(devServerConfig.rootDir) : process.cwd();
  let server: net.Server;

  return {
    async start({ config, testFiles, sessions, runner }) {
      function onRerunSessions(sessionIds?: string[]) {
        const sessionsToRerun = sessionIds
          ? sessionIds.map(id => {
              const session = sessions.get(id);
              if (!session) {
                throw new Error(`Could not find session ${id}`);
              }
              return session;
            })
          : sessions.all();
        runner.runTests(sessionsToRerun);
      }

      function onRequest404(sessionId: string, url: string) {
        const session = sessions.get(sessionId);
        if (!session) {
          throw new Error(`Could not find session ${sessionId}`);
        }

        const { request404s } = session;
        if (!request404s.includes(url)) {
          sessions.update({ ...session, request404s: [...request404s, url] });
        }
      }

      const fileWatcher = chokidar.watch([]);
      const serverConfig = createConfig(
        deepmerge(
          {
            port: config.port,
            nodeResolve: true,
            logStartup: false,
            logCompileErrors: false,
            babelConfig: config.coverage
              ? {
                  plugins: [
                    [
                      require.resolve('babel-plugin-istanbul'),
                      {
                        exclude:
                          typeof config.coverage === 'boolean'
                            ? [testFiles]
                            : [...testFiles, ...(config.coverage.exclude ?? [])],
                      },
                    ],
                  ],
                }
              : undefined,
            middlewares: [
              async function middleware(ctx: Context, next: Next) {
                if (ctx.path.startsWith('/wtr/')) {
                  const [, , sessionId, command] = ctx.path.split('/');
                  if (!sessionId) return next();
                  if (!command) return next();

                  const session = sessions.get(sessionId);
                  if (!session) {
                    ctx.status = 400;
                    ctx.body = `Session id ${sessionId} not found`;
                    console.error(ctx.body);
                    return;
                  }

                  if (command === 'config') {
                    ctx.body = JSON.stringify({
                      ...session,
                      testFile: createBrowserFilePath(rootDir, session.testFile),
                      watch: !!config.watch,
                    } as any);
                    return;
                  }

                  // TODO: Handle race conditions for these requests
                  if (command === 'session-started') {
                    ctx.status = 200;
                    sessions.updateStatus(session, SESSION_STATUS.STARTED);
                    return;
                  }

                  if (command === 'session-finished') {
                    ctx.status = 200;
                    const result = (await parse.json(ctx)) as any;
                    sessions.updateStatus(
                      {
                        ...session,
                        ...result,
                      },
                      SESSION_STATUS.FINISHED,
                    );
                    return;
                  }
                }

                return next();
              },

              dependencyGraphMiddleware({
                rootDir,
                fileWatcher,
                onRequest404,
                onRerunSessions,
              }),
            ],
            plugins: [
              {
                serve(context: Context) {
                  if (context.path === '/') {
                    return {
                      type: 'html',
                      body: config.testRunnerHtml
                        ? config.testRunnerHtml(config)
                        : createTestPage(context, config.testFrameworkImport),
                    };
                  }
                },
              },
            ],
          },
          devServerConfig,
        ),
      );

      ({ server } = await startServer(serverConfig, fileWatcher));
    },

    async stop() {
      await server?.close();
    },
  };
}