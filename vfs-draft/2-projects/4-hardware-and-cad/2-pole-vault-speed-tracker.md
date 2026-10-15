# Pole Vault Speed Tracker

*Solo project, 2026*

A timing system for pole vault run-ups: two Arduino-based timing gates time the last 10 meters of the approach, and a desktop app shows the split and average speed.

### What I built
* A Windows desktop app in React Native for Windows that reads gate timestamps over USB serial.
* A custom C++ native module to find and open serial ports.
* The dashboard, settings and speed calculations.

### Tech
* React Native for Windows
* C++/WinRT
* TypeScript
* Arduino, USB serial
