include ../../config.mk

.PHONY : all binary check clean reallyclean test install uninstall

PLUGIN_NAME=libsql_plugin

all : binary

binary : ${PLUGIN_NAME}.so

${PLUGIN_NAME}.so : ${PLUGIN_NAME}.c
		$(CROSS_COMPILE)$(CC) -I../.. -I../../include -I../../lib $(PLUGIN_CPPFLAGS) $(PLUGIN_CFLAGS) $(PLUGIN_LDFLAGS) -shared $< -o $@ -lsqlite3 -lpthread ../../lib/libmosquitto.so.1

reallyclean : clean
clean:
		-rm -f *.o ${PLUGIN_NAME}.so *.gcda *.gcno

check: test
test:

install: ${PLUGIN_NAME}.so
		$(INSTALL) -d "${DESTDIR}$(libdir)"
		$(INSTALL) ${STRIP_OPTS} ${PLUGIN_NAME}.so "${DESTDIR}${libdir}/${PLUGIN_NAME}.so"

uninstall :
		-rm -f "${DESTDIR}${libdir}/${PLUGIN_NAME}.so"