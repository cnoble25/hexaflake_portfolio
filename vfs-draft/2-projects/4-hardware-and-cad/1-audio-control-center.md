# Audio Control Center

*Solo project, 2025*

A physical volume mixer: three sliders on an Arduino board control Windows' master volume and individual apps' volumes.

### What I built
* Arduino Nano firmware that reads three slider potentiometers and streams them over serial.
* A .NET MAUI Windows app that maps each slider to the system or a chosen app through CoreAudio, with a settings page, a tray service, noise filtering and COM-port detection.
* A case and mount for the board, designed in Onshape.

### Tech
* C#, .NET MAUI
* Arduino
* Serial communication
* Onshape

- [Source code](https://github.com/cnoble25/Audio-Control-Center-Project)
- [Case in Onshape](https://cad.onshape.com/documents/735612e94a3a837770020975/w/c482477898f5c92e9bab10c5/e/fa7bc7a80d6479d17c758054)
