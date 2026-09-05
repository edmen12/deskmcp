#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int ends_with(const char *value, const char *suffix) {
    const size_t value_len = strlen(value);
    const size_t suffix_len = strlen(suffix);
    return value_len >= suffix_len
        && strcmp(value + value_len - suffix_len, suffix) == 0;
}

static const char *requested_shell(const char *argv0) {
    const char *base = strrchr(argv0, '/');
    base = base ? base + 1 : argv0;
    if (ends_with(base, "-zsh")) return "zsh";
    if (ends_with(base, "-bash")) return "bash";
    if (ends_with(base, "-sh")) return "sh";
    if (ends_with(base, "-fish")) return "fish";
    return "auto";
}

static int is_allowed_shell_basename(const char *shell_path) {
    const char *base = strrchr(shell_path, '/');
    base = base ? base + 1 : shell_path;
    return strcmp(base, "zsh") == 0
        || strcmp(base, "bash") == 0
        || strcmp(base, "sh") == 0
        || strcmp(base, "fish") == 0;
}

static const char *first_executable(const char *const *candidates) {
    for (size_t i = 0; candidates[i] != NULL; ++i) {
        if (access(candidates[i], X_OK) == 0) return candidates[i];
    }
    return NULL;
}

static const char *resolve_shell(const char *name) {
    if (strcmp(name, "zsh") == 0) return access("/bin/zsh", X_OK) == 0 ? "/bin/zsh" : NULL;
    if (strcmp(name, "bash") == 0) return access("/bin/bash", X_OK) == 0 ? "/bin/bash" : NULL;
    if (strcmp(name, "sh") == 0) return access("/bin/sh", X_OK) == 0 ? "/bin/sh" : NULL;
    if (strcmp(name, "fish") == 0) {
        static const char *const fish_candidates[] = {
            "/opt/homebrew/bin/fish",
            "/usr/local/bin/fish",
            "/usr/bin/fish",
            NULL
        };
        return first_executable(fish_candidates);
    }
    if (strcmp(name, "auto") == 0) {
        const char *configured = getenv("SHELL");
        if (configured != NULL
            && configured[0] == '/'
            && is_allowed_shell_basename(configured)
            && access(configured, X_OK) == 0) {
            return configured;
        }
        if (access("/bin/zsh", X_OK) == 0) return "/bin/zsh";
        if (access("/bin/bash", X_OK) == 0) return "/bin/bash";
        if (access("/bin/sh", X_OK) == 0) return "/bin/sh";
    }
    return NULL;
}

static const char *find_command(int argc, char **argv) {
    for (int i = 1; i + 1 < argc; ++i) {
        if (strcmp(argv[i], "-c") == 0 || strcmp(argv[i], "-lc") == 0) {
            return argv[i + 1];
        }
    }
    return NULL;
}

int main(int argc, char **argv) {
    const char *command = find_command(argc, argv);
    if (command == NULL || *command == '\0') {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR missing command payload\n");
        return 64;
    }

    const char *shell_name = requested_shell(argv[0]);
    const char *shell_path = resolve_shell(shell_name);
    if (shell_path == NULL) {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR requested shell unavailable: %s\n", shell_name);
        return 69;
    }

    if (setsid() == -1) {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR setsid failed errno=%d (%s)\n", errno, strerror(errno));
        return 70;
    }

    if (strcmp(shell_name, "sh") == 0 || strcmp(shell_path, "/bin/sh") == 0) {
        execl(shell_path, shell_path, "-c", command, (char *)NULL);
    } else {
        execl(shell_path, shell_path, "-l", "-c", command, (char *)NULL);
    }

    fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR exec failed errno=%d (%s) shell=%s\n", errno, strerror(errno), shell_path);
    return 71;
}
