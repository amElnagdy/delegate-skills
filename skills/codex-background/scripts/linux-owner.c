// Linux subreaper: own reparented descendants even when relays create new sessions.
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
static volatile sig_atomic_t stopping = 0;
static void stop(int signal_number) { (void)signal_number; stopping = 1; }
static long milliseconds(void) { struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now); return now.tv_sec * 1000L + now.tv_nsec / 1000000L; }
static const char *signal_name(int number) {
  switch (number) { case SIGTERM: return "SIGTERM"; case SIGKILL: return "SIGKILL"; case SIGINT: return "SIGINT"; case SIGQUIT: return "SIGQUIT"; case SIGHUP: return "SIGHUP"; case SIGPIPE: return "SIGPIPE"; case SIGSEGV: return "SIGSEGV"; case SIGABRT: return "SIGABRT"; default: return "UNKNOWN"; }
}
static int record_exit(const char *directory, int status) {
  char path[PATH_MAX], temporary[PATH_MAX];
  if (snprintf(path, sizeof path, "%s/relay-exit.json", directory) >= (int)sizeof path || snprintf(temporary, sizeof temporary, "%s.tmp", path) >= (int)sizeof temporary) return -1;
  FILE *file = fopen(temporary, "w"); if (!file) return -1;
  if (WIFEXITED(status)) fprintf(file, "{\"exitCode\":%d,\"signal\":null}", WEXITSTATUS(status));
  else fprintf(file, "{\"exitCode\":null,\"signal\":\"%s\",\"signalNumber\":%d}", signal_name(WTERMSIG(status)), WTERMSIG(status));
  if (fclose(file) != 0) return -1;
  return rename(temporary, path);
}
static int signal_owned_children(int signal_number) {
  char path[128]; snprintf(path, sizeof path, "/proc/self/task/%ld/children", (long)getpid());
  FILE *file = fopen(path, "r"); if (!file) return -1;
  long pid;
  // These are our direct children and are not reaped during this snapshot/kill loop.
  // Their IDs cannot be reused for unrelated processes until we subsequently waitpid.
  while (fscanf(file, "%ld", &pid) == 1) if (kill((pid_t)pid, signal_number) != 0 && errno != ESRCH) { fclose(file); return -1; }
  return fclose(file);
}
int main(int argc, char **argv) {
  if (argc < 4) return 2;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) { perror("subreaper initialization"); return 1; }
  struct sigaction action = {0}; action.sa_handler = stop; sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0) { perror("signal initialization"); return 1; }
  if (signal_owned_children(0) != 0) { perror("procfs ownership initialization"); return 1; }
  pid_t root = fork(); if (root < 0) { perror("fork"); return 1; }
  if (root == 0) { signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); execv(argv[2], &argv[2]); perror("relay exec"); _exit(127); }
  long stop_at = 0; int root_seen = 0, failed = 0;
  for (;;) {
    if (stopping) {
      if (!stop_at) {
        stop_at = milliseconds();
        if (signal_owned_children(SIGTERM) != 0) { perror("owned children"); failed = 1; }
      } else if (milliseconds() - stop_at >= 1000 && signal_owned_children(SIGKILL) != 0) { perror("owned children"); failed = 1; }
    }
    int status; pid_t child;
    while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
      if (child == root) { root_seen = 1; if (record_exit(argv[1], status) != 0) { perror("relay exit record"); failed = 1; stopping = 1; } }
    }
    if (child < 0 && errno == ECHILD) return root_seen && !failed ? 0 : 1;
    if (child < 0 && errno != EINTR) { perror("waitpid"); stopping = 1; failed = 1; }
    struct timespec pause = {0, 10000000}; nanosleep(&pause, NULL);
  }
}
