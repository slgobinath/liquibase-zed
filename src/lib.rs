use std::fs;

use zed_extension_api::{
    self as zed, current_platform, serde_json::json, settings::LspSettings, Architecture,
    DownloadedFileType, LanguageServerId, LanguageServerInstallationStatus, Os, Result,
};

const XML_SERVER_ID: &str = "liquibase-xml-lsp";
const YAML_SERVER_ID: &str = "liquibase-yaml-lsp";
const LIQUIBASE_SERVER_ID: &str = "liquibase-lsp";

/// The bundled Liquibase server and its support files, written next to each other
/// in the extension's work directory (where `yaml` is installed from npm).
const LIQUIBASE_SERVER_FILES: [(&str, &str); 3] = [
    ("liquibase-server.js", include_str!("liquibase-server.js")),
    ("liquibase-validate.js", include_str!("liquibase-validate.js")),
    ("liquibase-model.json", include_str!("liquibase-model.json")),
];
const LIQUIBASE_SERVER_ENTRY: &str = "liquibase-server.js";
const YAML_PARSER_PACKAGE: &str = "yaml";

const YAML_PACKAGE: &str = "yaml-language-server";
const YAML_SERVER_PATH: &str = "node_modules/yaml-language-server/bin/yaml-language-server";

const LIQUIBASE_XSD: &str = "http://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-latest.xsd";
const LIQUIBASE_YAML_SCHEMA: &str = "https://www.schemastore.org/liquibase-3.2.json";

struct LiquibaseExtension {
    cached_lemminx_path: Option<String>,
}

impl LiquibaseExtension {
    /// Locates LemMinX: a user-supplied binary on the PATH wins, otherwise the
    /// release from `redhat-developer/vscode-xml` is downloaded once and reused.
    fn lemminx_path(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<String> {
        if let Some(path) = worktree.which("lemminx") {
            return Ok(path);
        }

        if let Some(path) = &self.cached_lemminx_path {
            if fs::metadata(path).map_or(false, |stat| stat.is_file()) {
                return Ok(path.clone());
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let release = zed::latest_github_release(
            "redhat-developer/vscode-xml",
            zed::GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )?;

        let (os, arch) = current_platform();
        let platform = match (os, arch) {
            (Os::Mac, Architecture::Aarch64) => "osx-aarch_64",
            (Os::Mac, _) => "osx-x86_64",
            (Os::Linux, Architecture::Aarch64) => "linux-aarch_64",
            (Os::Linux, _) => "linux-x86_64",
            (Os::Windows, _) => "win32",
        };
        let asset_name = format!("lemminx-{platform}.zip");
        let asset = release
            .assets
            .iter()
            .find(|asset| asset.name == asset_name)
            .ok_or_else(|| format!("no asset named {asset_name} in release {}", release.version))?;

        let version_dir = format!("lemminx-{}", release.version);
        let binary_name = if os == Os::Windows {
            "lemminx-win32.exe".to_string()
        } else {
            format!("lemminx-{platform}")
        };
        let binary_path = format!("{version_dir}/{binary_name}");

        if !fs::metadata(&binary_path).map_or(false, |stat| stat.is_file()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );
            zed::download_file(&asset.download_url, &version_dir, DownloadedFileType::Zip)
                .map_err(|err| format!("failed to download LemMinX: {err}"))?;
            zed::make_file_executable(&binary_path)?;

            // Drop older versions so they don't pile up.
            if let Ok(entries) = fs::read_dir(".") {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with("lemminx-") && name != version_dir {
                        fs::remove_dir_all(entry.path()).ok();
                    }
                }
            }
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
        self.cached_lemminx_path = Some(binary_path.clone());
        Ok(binary_path)
    }

    fn yaml_server_path(&mut self, language_server_id: &LanguageServerId) -> Result<String> {
        let server_exists = fs::metadata(YAML_SERVER_PATH).map_or(false, |stat| stat.is_file());

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let latest = zed::npm_package_latest_version(YAML_PACKAGE);
        let installed = zed::npm_package_installed_version(YAML_PACKAGE)?;

        // Offline or registry failure: keep using what we have.
        let needs_install = match (&latest, &installed) {
            (Ok(latest), Some(installed)) => latest != installed || !server_exists,
            (Err(_), _) => !server_exists,
            (_, None) => true,
        };

        if needs_install {
            let version = latest?;
            zed::set_language_server_installation_status(
                language_server_id,
                &LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(YAML_PACKAGE, &version)?;
        }

        zed::set_language_server_installation_status(
            language_server_id,
            &LanguageServerInstallationStatus::None,
        );
        Ok(YAML_SERVER_PATH.to_string())
    }
}

impl zed::Extension for LiquibaseExtension {
    fn new() -> Self {
        Self {
            cached_lemminx_path: None,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        match language_server_id.as_ref() {
            XML_SERVER_ID => Ok(zed::Command {
                command: self.lemminx_path(language_server_id, worktree)?,
                args: vec![],
                env: vec![],
            }),
            YAML_SERVER_ID => {
                let server_path = self.yaml_server_path(language_server_id)?;
                let server_path = std::env::current_dir()
                    .map_err(|err| err.to_string())?
                    .join(server_path)
                    .to_string_lossy()
                    .to_string();
                Ok(zed::Command {
                    command: zed::node_binary_path()?,
                    args: vec![server_path, "--stdio".to_string()],
                    env: vec![],
                })
            }
            LIQUIBASE_SERVER_ID => {
                if zed::npm_package_installed_version(YAML_PARSER_PACKAGE)?.is_none() {
                    zed::set_language_server_installation_status(
                        language_server_id,
                        &LanguageServerInstallationStatus::Downloading,
                    );
                    let version = zed::npm_package_latest_version(YAML_PARSER_PACKAGE)?;
                    zed::npm_install_package(YAML_PARSER_PACKAGE, &version)?;
                    zed::set_language_server_installation_status(
                        language_server_id,
                        &LanguageServerInstallationStatus::None,
                    );
                }
                for (name, contents) in LIQUIBASE_SERVER_FILES {
                    fs::write(name, contents).map_err(|err| format!("failed to write {name}: {err}"))?;
                }
                let script = std::env::current_dir()
                    .map_err(|err| err.to_string())?
                    .join(LIQUIBASE_SERVER_ENTRY)
                    .to_string_lossy()
                    .to_string();
                Ok(zed::Command {
                    command: zed::node_binary_path()?,
                    args: vec![script],
                    env: vec![],
                })
            }
            other => Err(format!("unknown language server: {other}")),
        }
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let user_options = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.initialization_options);
        if user_options.is_some() || language_server_id.as_ref() != XML_SERVER_ID {
            return Ok(user_options);
        }

        // Fallback for changelogs without an `xsi:schemaLocation`: validate and
        // complete against the latest Liquibase XSD.
        Ok(Some(json!({
            "settings": {
                "xml": {
                    "fileAssociations": [
                        { "pattern": "**/*.xml", "systemId": LIQUIBASE_XSD }
                    ],
                    "downloadExternalResources": { "enabled": true },
                    "validation": { "enabled": true, "noGrammar": "ignore" }
                }
            }
        })))
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>> {
        let user_settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)
            .ok()
            .and_then(|settings| settings.settings);
        if user_settings.is_some() || language_server_id.as_ref() != YAML_SERVER_ID {
            return Ok(user_settings);
        }

        Ok(Some(json!({
            "yaml": {
                // The SchemaStore schema rejects valid changelogs (e.g. numeric ids) and never flags
                // unknown keys, so validation is left to the bundled Liquibase server.
                "validate": false,
                "completion": true,
                "hover": true,
                "schemas": { LIQUIBASE_YAML_SCHEMA: ["**/*"] }
            }
        })))
    }
}

zed::register_extension!(LiquibaseExtension);
