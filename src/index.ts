import { AliasManager } from "./aliases";
import { handle_incoming_email } from "./relay";

// Re-export entrypoint classes for the website worker to use.
export { AliasManager };

export default {
    fetch: async (request, env, ctx) => {
        try {
            let { pathname } = new URL(request.url);
            if (!pathname.endsWith("/")) {
                pathname += "/";
            }
            if (pathname === "/") {
                return handle_incoming_email(request, env, ctx);
            } else if (pathname.startsWith("/alias/")) {
                const promise = new AliasManager(ctx, env).fetch(request);
                // Prevent the worker from being cancelled
                // before the database operations complete.
                ctx.waitUntil(promise);
                return promise;
            }
            console.log({ message: "Not found", pathname });
            return new Response("Not Found", { status: 404 });
        } catch (error) {
            const { stack, message } = error instanceof Error ? error : { stack: undefined, message: `${error}` };
            console.error({ message: "Unhandled error", error: message, stack });
            return new Response("Internal Server Error", { status: 500 });
        }
    },

    scheduled: async (controller, env, ctx) => {
        ctx.waitUntil(new AliasManager(ctx, env).delete_expired_aliases());
    },
} satisfies ExportedHandler<Env>;
