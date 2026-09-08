# App is not minified for phase-1 sideload builds; rules below document the
# keep requirements that would apply if minification/R8 is enabled later.
# -keep class app.lamasync.companion.core.** { *; }
# kotlinx.serialization keeps (generated serializers are referenced reflectively):
# -keepclassmembers class app.lamasync.companion.** {
#     *** Companion;
# }
# -keepclasseswithmembers class app.lamasync.companion.** {
#     kotlinx.serialization.KSerializer serializer(...);
# }
