# Docker MCP Catalog entry (staged)

The three files under `servers/jobo/` are the entry for
[`docker/mcp-registry`](https://github.com/docker/mcp-registry), in the shape its
`task remote-wizard` generates for a remote server with OAuth (the in-repo `servers/linear`
entry is the template). Nothing here is built or published from this repo; the files are
copied into a fork of the registry and submitted as a pull request.

The submission steps, and what is still unknown about how Docker registers its OAuth client
for a remote server, are in [`MCP-DISTRIBUTION.md`](../../../MCP-DISTRIBUTION.md) §4.

| File | Purpose |
| --- | --- |
| `server.yaml` | Name, category, title, description, icon, remote endpoint and the OAuth block. |
| `tools.json` | Always `[]` for a remote server: the catalog discovers tools dynamically. |
| `readme.md` | The documentation link the catalog shows. |

`tools.json` and `readme.md` are exactly what the wizard writes; `server.yaml` differs from
the wizard's output only in the icon, which points at Jobo's own icon rather than a favicon
service.
