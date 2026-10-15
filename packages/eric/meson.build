project('SteuerEric', ['c', 'vala'], version: '1.0')

cc = meson.get_compiler('c')

dependencies = [
    dependency('glib-2.0'),
    dependency('gobject-2.0'),
]

# ERiC itself is NOT linked: eric-shim.c opens libericapi.so by absolute path at runtime, so this
# binding builds anywhere (CI included) and needs no ERiC at build time.
dl_dep = cc.find_library('dl', required: false)

sources = files('src/vala/eric.vala', 'src/vala/eric-send.c', 'src/vala/eric-shim.c')

libSteuerEric = library('steuereric', sources,
    dependencies: dependencies + [dl_dep],
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
