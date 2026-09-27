//! The machine login `roger login` saves: `~/.config/roger/credentials`.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// A machine credential and where it is valid. Written with mode 0600.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    /// The Roger server that issued it; never sent anywhere else.
    pub url: String,
    /// The machine name chosen when approving.
    pub machine: String,
    /// GitHub login of the person who approved it.
    pub owner: String,
    /// The `rogm_` credential.
    pub credential: String,
}

/// `$XDG_CONFIG_HOME/roger/<name>`, else `~/.config/roger/<name>`.
pub fn config_file(name: &str) -> Option<PathBuf> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(config.join("roger").join(name))
}

fn file_error(action: &'static str, path: &Path) -> impl FnOnce(std::io::Error) -> Error {
    let path = path.to_owned();
    move |source| Error::CredentialsFile {
        action,
        path,
        source,
    }
}

/// Reads saved credentials; `None` when the file does not exist.
pub fn load(path: &Path) -> Result<Option<Credentials>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(file_error("reading", path)(err)),
    };
    serde_json::from_str(&text).map(Some).map_err(|err| {
        file_error("reading", path)(std::io::Error::new(std::io::ErrorKind::InvalidData, err))
    })
}

/// Writes credentials readable only by this user, replacing the file
/// atomically so a failed write never leaves half a credential.
pub fn save(path: &Path, credentials: &Credentials) -> Result<()> {
    let dir = path.parent().ok_or(Error::NoConfigDir)?;
    create_private_dir(dir).map_err(file_error("creating the directory of", path))?;
    let temp = path.with_extension("tmp");
    let json = serde_json::to_string_pretty(credentials)?;
    let written = open_private(&temp).and_then(|mut file| {
        file.write_all(json.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()
    });
    if let Err(err) = written.and_then(|()| std::fs::rename(&temp, path)) {
        // Best effort: the temporary file may not exist.
        let _ = std::fs::remove_file(&temp);
        return Err(file_error("writing", path)(err));
    }
    Ok(())
}

/// Deletes the credentials file; a missing file is not an error.
pub fn remove(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            Err(file_error("deleting", path)(err))
        }
        _ => Ok(()),
    }
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` applies only when the file is created; tighten a leftover one.
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::File::create(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("roger-cli-{name}-{}", std::process::id()))
    }

    fn sample() -> Credentials {
        Credentials {
            url: "https://roger.test".to_owned(),
            machine: "studio".to_owned(),
            owner: "someone".to_owned(),
            credential: "rogm_x".to_owned(),
        }
    }

    #[test]
    fn saves_and_loads_with_owner_only_permissions() -> TestResult {
        let dir = temp_dir("save");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("roger").join("credentials");
        assert_eq!(load(&path)?, None);
        save(&path, &sample())?;
        assert_eq!(load(&path)?, Some(sample()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path)?.permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(dir.join("roger"))?.permissions().mode() & 0o777,
                0o700
            );
        }
        assert!(!path.with_extension("tmp").exists());
        remove(&path)?;
        assert_eq!(load(&path)?, None);
        remove(&path)?;
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn tightens_a_file_left_readable() -> TestResult {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("tighten");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("credentials");
        std::fs::write(path.with_extension("tmp"), "old")?;
        std::fs::set_permissions(
            path.with_extension("tmp"),
            std::fs::Permissions::from_mode(0o644),
        )?;
        save(&path, &sample())?;
        assert_eq!(
            std::fs::metadata(&path)?.permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn a_corrupt_file_is_an_error_not_a_logout() -> TestResult {
        let dir = temp_dir("corrupt");
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("credentials");
        std::fs::write(&path, "not json")?;
        assert!(matches!(load(&path), Err(Error::CredentialsFile { .. })));
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
