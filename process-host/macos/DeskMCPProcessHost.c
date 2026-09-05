#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t shutdown_signal = 0;

static void on_shutdown_signal(int signal_number) {
    if (shutdown_signal == 0) shutdown_signal = signal_number;
}

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

static void sleep_milliseconds(long milliseconds) {
    struct timespec request = {
        .tv_sec = milliseconds / 1000,
        .tv_nsec = (milliseconds % 1000) * 1000000L
    };
    while (nanosleep(&request, &request) == -1 && errno == EINTR) {
    }
}

static int install_supervisor_signal_handlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_shutdown_signal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL) == -1) return -1;
    if (sigaction(SIGINT, &action, NULL) == -1) return -1;
    if (sigaction(SIGHUP, &action, NULL) == -1) return -1;
    return 0;
}

static void restore_child_signal_defaults(void) {
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
}

static int exit_code_from_wait_status(int status) {
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 1;
}

static void spawn_final_group_reaper(pid_t owned_pgid, long delay_ms) {
    pid_t reaper = fork();
    if (reaper != 0) return;

    restore_child_signal_defaults();
    if (setsid() == -1) _exit(73);
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
    sleep_milliseconds(delay_ms);
    if (kill(-owned_pgid, SIGKILL) == -1 && errno != ESRCH) _exit(74);
    _exit(0);
}

static void begin_group_shutdown(pid_t owned_pgid) {
    if (kill(-owned_pgid, SIGTERM) == -1 && errno != ESRCH) {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR group SIGTERM failed errno=%d (%s)\n", errno, strerror(errno));
    }
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

    const pid_t owner_pid = getppid();
    if (setsid() == -1) {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR setsid failed errno=%d (%s)\n", errno, strerror(errno));
        return 70;
    }
    const pid_t owned_pgid = getpgrp();

    if (install_supervisor_signal_handlers() == -1) {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR sigaction failed errno=%d (%s)\n", errno, strerror(errno));
        return 71;
    }

    const pid_t shell_pid = fork();
    if (shell_pid == -1) {
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR fork failed errno=%d (%s)\n", errno, strerror(errno));
        return 72;
    }

    if (shell_pid == 0) {
        restore_child_signal_defaults();
        if (strcmp(shell_name, "sh") == 0 || strcmp(shell_path, "/bin/sh") == 0) {
            execl(shell_path, shell_path, "-c", command, (char *)NULL);
        } else {
            execl(shell_path, shell_path, "-l", "-c", command, (char *)NULL);
        }
        fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR exec failed errno=%d (%s) shell=%s\n", errno, strerror(errno), shell_path);
        _exit(127);
    }

    int child_status = 0;
    int shutdown_started = 0;
    int shutdown_ticks = 0;

    for (;;) {
        const pid_t waited = waitpid(shell_pid, &child_status, WNOHANG);
        if (waited == shell_pid) {
            // The command root is gone. Mirror Windows Job Object semantics by
            // killing any background descendants that remain in the owned PGID.
            spawn_final_group_reaper(owned_pgid, 100);
            return exit_code_from_wait_status(child_status);
        }
        if (waited == -1 && errno != EINTR) {
            fprintf(stderr, "DESKMCP_PROCESS_HOST_ERROR waitpid failed errno=%d (%s)\n", errno, strerror(errno));
            spawn_final_group_reaper(owned_pgid, 100);
            return 75;
        }

        if (getppid() != owner_pid && shutdown_signal == 0) {
            // Desktop Commander/Gateway disappeared. Treat owner loss like a
            // Job Object handle close and tear down the whole process group.
            shutdown_signal = SIGHUP;
        }

        if (shutdown_signal != 0) {
            if (!shutdown_started) {
                begin_group_shutdown(owned_pgid);
                shutdown_started = 1;
            }
            shutdown_ticks += 1;
            if (shutdown_ticks >= 10) {
                // Leave the old process group before the final SIGKILL so the
                // cleanup helper cannot kill itself before delivering it.
                spawn_final_group_reaper(owned_pgid, 20);
                return 128 + shutdown_signal;
            }
        }

        sleep_milliseconds(50);
    }
}
