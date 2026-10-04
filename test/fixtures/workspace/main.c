#include <stdio.h>

int main(void) {
    fputs("betelgeuz e2e: hello from the CMake-built target\n", stdout);
    fputs("betelgeuz e2e: a stderr line\n", stderr);
    return 0;
}
