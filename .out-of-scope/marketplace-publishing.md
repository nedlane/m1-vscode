# VS Code Marketplace and Open VSX publishing

m1-vscode is distributed through GitHub Releases. The project does not publish
the extension to the VS Code Marketplace or Open VSX.

## Why this is out of scope

The release workflow already builds the supported per-platform VSIX packages
and publishes them with each GitHub release. Adding either marketplace would
create another release destination with its own publisher account, access
token, repository secrets and failure handling.

That external account and credential ownership is not part of this project's
release model. Keeping GitHub Releases as the only distribution channel gives
the project one set of published artifacts and avoids long-lived marketplace
credentials. The existing publisher metadata does not imply that marketplace
publishing is supported.

## Prior requests

- #79: "Decide: publish to VS Code Marketplace / Open VSX"
