#include <Python.h>

#include "tree_sitter/parser.h"

const TSLanguage *tree_sitter_posix_sed(void);
const TSLanguage *tree_sitter_posix_sed_ere(void);

static PyObject *language_posix_sed(PyObject *self, PyObject *args) {
  (void)self;
  (void)args;
  return PyCapsule_New(
    (void *)tree_sitter_posix_sed(),
    "tree_sitter.Language",
    NULL
  );
}

static PyObject *language_posix_sed_ere(PyObject *self, PyObject *args) {
  (void)self;
  (void)args;
  return PyCapsule_New(
    (void *)tree_sitter_posix_sed_ere(),
    "tree_sitter.Language",
    NULL
  );
}

static PyMethodDef methods[] = {
  {"language_posix_sed",
    language_posix_sed,
    METH_NOARGS,
    "Return the posix_sed language capsule."},
  {"language_posix_sed_ere",
    language_posix_sed_ere,
    METH_NOARGS,
    "Return the posix_sed_ere language capsule."},
  {NULL, NULL, 0, NULL},
};

static struct PyModuleDef module = {
  PyModuleDef_HEAD_INIT,
  .m_name = "binding",
  .m_size = -1,
  .m_methods = methods,
};

PyMODINIT_FUNC PyInit_binding(void) {
  return PyModule_Create(&module);
}
