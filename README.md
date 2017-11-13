
SensEdge
========

This repo is for ElderSens Inc's SensEdge Project.

###Build on MacOS

0. Make sure Xcode is installed
https://developer.apple.com/xcode/downloads/

1. Install Homebrew if it's not already installed
`ruby -e "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/master/install)"`

2. Install Node.js and npm
`brew install node`

3. Install MQTT client mosquitto
`brew install mosquitto`

4. Install Node.js modules: noble, nodemailer, ip, etc.
`./run.sh install`

###Build on Raspberry Pi
`./run.sh install`

###FallSens Calibration
`./run.sh calibration`
When it's finished, append the generated line to calibrationTable in sensedge.js.

###Run
`./run.sh`
