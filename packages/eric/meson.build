project('SteuerEric', ['c', 'vala'], version: '1.0')

cc = meson.get_compiler('c')

dependencies = [
    dependency('glib-2.0'),
    dependency('gobject-2.0'),
]

# ERiC shared library (libericapi.so) — user-provided, never shipped. Point the
# linker at $ERIC_HOME/lib via -Deric_lib_dir=... (else rely on default paths).
eric_lib_dir = get_option('eric_lib_dir')
if eric_lib_dir != ''
    eric_dep = cc.find_library('ericapi', dirs: [eric_lib_dir], required: true)
else
    eric_dep = cc.find_library('ericapi', required: true)
endif

sources = files('src/vala/eric.vala', 'src/vala/eric-send.c')

libSteuerEric = library('steuereric', sources,
    dependencies: dependencies + [eric_dep],
    include_directories: include_directories('src/vala'),
    vala_gir: meson.project_name() + '-1.0.gir',
    install: true,
    install_dir: [true, true, true, true],
)

g_ir_compiler = find_program('g-ir-compiler')

custom_target(meson.project_name() + '-1.0.typelib',
    command: [
        g_ir_compiler,
        '--shared-library', 'libsteuereric.so',
        '--output', '@OUTPUT@',
        meson.current_build_dir() / meson.project_name() + '-1.0.gir',
    ],
    output: meson.project_name() + '-1.0.typelib',
    depends: libSteuerEric,
    install: true,
    install_dir: get_option('libdir') / 'girepository-1.0',
)
