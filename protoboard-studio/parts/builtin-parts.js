/* ============================================================
   builtin-parts.js — the stock breakout / component library.

   Everything here is plain data, so it is easy to hand-edit.  A part
   definition looks like:

     {
       id:'nano-v3', name:'Arduino Nano v3', category:'Dev boards',
       refPrefix:'U',
       w:15, h:7,            // body size, in HOLES (grid cells spanned)
       ox:-0.5, oy:-0.5,     // body top-left, in holes, from the part origin
       color:'#1b4a7a', shape:'rounded',
       pins:[ {n:'1', name:'D1/TX', c:0, r:0, type:'io'}, ... ]
     }

   A pin sits on board hole (part.col + c, part.row + r) before rotation.
   Pin types drive the colour dots:  pwr gnd io analog in out clk data nc
   ============================================================ */
(function () {
  'use strict';

  /* ---------- small builders ---------------------------------------- */

  /** Two parallel header rows `gap` holes apart (the classic breakout). */
  function dual(o) {
    const pins = [];
    let n = 0;
    o.left.forEach(function (nm, i) { pins.push(pin(++n, nm, i, 0)); });
    o.right.forEach(function (nm, i) { pins.push(pin(++n, nm, i, o.gap)); });
    const w = Math.max(o.left.length, o.right.length);
    return def(o, {
      w: o.w || w, h: o.h || (o.gap + 1),
      ox: o.ox === undefined ? -0.5 : o.ox,
      oy: o.oy === undefined ? -0.5 : o.oy,
      pins: pins
    });
  }

  /** A single row of pins running along +c. */
  function inline(o) {
    const pins = o.names.map(function (nm, i) { return pin(i + 1, nm, i, 0); });
    return def(o, {
      w: o.w || o.names.length, h: o.h || 1,
      ox: o.ox === undefined ? -0.5 : o.ox,
      oy: o.oy === undefined ? -0.5 : o.oy,
      pins: pins
    });
  }

  /** Two pins `span` holes apart — resistors, diodes, LEDs, crystals. */
  function axial(o) {
    return def(o, {
      w: o.w || (o.span + 1), h: o.h || 1,
      ox: o.ox === undefined ? -0.5 : o.ox,
      oy: o.oy === undefined ? -0.5 : o.oy,
      pins: [pin(1, o.a || '1', 0, 0), pin(2, o.b || '2', o.span, 0)]
    });
  }

  /** DIP package: n pins total, `wide` holes between the two rows. */
  function dip(o) {
    const half = o.count / 2;
    const pins = [];
    for (let i = 0; i < half; i++) pins.push(pin(i + 1, (o.names && o.names[i]) || String(i + 1), i, o.wide));
    for (let i = 0; i < half; i++) {
      const idx = half + i;
      pins.push(pin(idx + 1, (o.names && o.names[idx]) || String(idx + 1), half - 1 - i, 0));
    }
    return def(o, {
      w: half, h: o.wide + 1, ox: -0.5, oy: -0.5,
      shape: 'dip', color: o.color || '#22262e', pins: pins
    });
  }

  function pin(n, name, c, r, type) {
    return { n: String(n), name: name, c: c, r: r, type: type || guessType(name) };
  }

  function guessType(name) {
    const s = String(name).toUpperCase().replace(/\s+/g, '');
    if (/^(GND|GND\d|AGND|DGND|VSS|-|0V|COM)$/.test(s)) return 'gnd';
    if (/^(VCC|VDD|VIN|V\+|\+?[35]V3?|\+?[0-9.]+V|5V|3V3|3\.3V|VBUS|VBAT|VM|VMOT|VOUT|RAW|BAT\+?|B\+)$/.test(s)) return 'pwr';
    if (/^(A\d|AREF|AIN\d?|ADC\d?|VREF)$/.test(s)) return 'analog';
    if (/^(SCK|SCL|CLK|XCK|OSC\d?)$/.test(s)) return 'clk';
    if (/^(SDA|SDI|SDO|MOSI|MISO|DIO|DATA|DQ|TX|RX|TXD|RXD|D\+|D-)$/.test(s)) return 'data';
    if (/^(NC|-|X)$/.test(s)) return 'nc';
    return 'io';
  }

  let auto = 0;
  function def(o, extra) {
    const d = Object.assign({
      id: o.id || ('part' + (++auto)),
      name: o.name,
      category: o.category || 'Misc',
      refPrefix: o.refPrefix || 'U',
      desc: o.desc || '',
      color: o.color || '#2b3a4a',
      shape: o.shape || 'rounded',
      textColor: o.textColor || null,
      tags: o.tags || [],
      builtin: true,
      through: o.through === undefined ? true : o.through,
      defaultValue: o.defaultValue || '',
      notch: o.notch || null,
      usb: o.usb || null,
      keepout: o.keepout || 0
    }, extra);
    return d;
  }

  /* ---------- name shorthands --------------------------------------- */
  const S = s => s.split(/\s+/);

  /* =================================================================
     DEV BOARDS
     ================================================================= */
  const DEV = [
    dual({
      id: 'nano-v3', name: 'Arduino Nano v3', category: 'Dev boards',
      desc: '18 x 45 mm, 0.6" row spacing', color: '#1d4f7c', usb: 'mini',
      tags: S('arduino nano atmega328 avr'), gap: 6,
      left:  S('D1/TX D0/RX RESET GND D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12'),
      right: S('VIN GND RESET 5V A7 A6 A5 A4 A3 A2 A1 A0 AREF 3V3 D13')
    }),
    dual({
      id: 'pro-mini', name: 'Arduino Pro Mini', category: 'Dev boards',
      desc: '18 x 33 mm, 0.6" row spacing', color: '#1d4f7c',
      tags: S('arduino promini atmega328'), gap: 6,
      left:  S('TXO RXI RST GND D2 D3 D4 D5 D6 D7 D8 D9'),
      right: S('RAW GND RST VCC A3 A2 A1 A0 D13 D12 D11 D10')
    }),
    dual({
      id: 'pro-micro', name: 'SparkFun Pro Micro', category: 'Dev boards',
      desc: '18 x 33 mm, ATmega32U4, native USB', color: '#8b1d3f', usb: 'micro',
      tags: S('sparkfun promicro atmega32u4 leonardo'), gap: 6,
      left:  S('TX0 RX1 GND GND D2 D3 D4 D5 D6 D7 D8 D9'),
      right: S('RAW GND RST VCC A3 A2 A1 A0 D15 D14 D16 D10')
    }),
    dual({
      id: 'esp32-devkit-30', name: 'ESP32 DevKit v1 (30p)', category: 'Dev boards',
      desc: '28 x 52 mm, 1.0" row spacing', color: '#1c1f24', usb: 'micro',
      tags: S('esp32 devkitc wroom wifi'), gap: 10,
      left:  S('EN VP/36 VN/39 D34 D35 D32 D33 D25 D26 D27 D14 D12 D13 GND VIN'),
      right: S('D23 D22 TX0 RX0 D21 GND D19 D18 D5 TX2 RX2 D4 D2 D15 3V3')
    }),
    dual({
      id: 'esp32-devkit-38', name: 'ESP32 DevKit (38p)', category: 'Dev boards',
      desc: '28 x 57 mm, 1.0" row spacing', color: '#1c1f24', usb: 'micro',
      tags: S('esp32 wroom 38pin'), gap: 10,
      left:  S('3V3 EN VP/36 VN/39 D34 D35 D32 D33 D25 D26 D27 D14 D12 GND D13 SD2 SD3 CMD'),
      right: S('GND D23 D22 TX0 RX0 D21 NC D19 D18 D5 D17 D16 D4 D0 D2 D15 SD1 SD0 CLK')
    }),
    dual({
      id: 'esp8266-nodemcu', name: 'NodeMCU ESP8266 v3', category: 'Dev boards',
      desc: '31 x 58 mm, 1.1" row spacing', color: '#1d5c4f', usb: 'micro',
      tags: S('esp8266 nodemcu lolin wifi'), gap: 11,
      left:  S('A0 RSV RSV SD3 SD2 SD1 CMD SD0 CLK GND 3V3 EN RST GND VIN'),
      right: S('D0 D1 D2 D3 D4 3V3 GND D5 D6 D7 D8 RX TX GND 3V3')
    }),
    dual({
      id: 'wemos-d1-mini', name: 'Wemos D1 mini', category: 'Dev boards',
      desc: '26 x 35 mm, 0.9" row spacing', color: '#1d5c4f', usb: 'micro',
      tags: S('esp8266 wemos d1mini'), gap: 9,
      left:  S('RST A0 D0 D5 D6 D7 D8 3V3'),
      right: S('TX RX D1 D2 D3 D4 GND 5V')
    }),
    dual({
      id: 'rpi-pico', name: 'Raspberry Pi Pico', category: 'Dev boards',
      desc: '21 x 51 mm, 0.7" row spacing, RP2040', color: '#1c1f24', usb: 'micro',
      tags: S('pico rp2040 raspberry'), gap: 7,
      left:  S('GP0 GP1 GND GP2 GP3 GP4 GP5 GND GP6 GP7 GP8 GP9 GND GP10 GP11 GP12 GP13 GND GP14 GP15'),
      right: S('VBUS VSYS GND 3V3EN 3V3 ADCREF GP28 AGND GP27 GP26 RUN GP22 GND GP21 GP20 GP19 GP18 GND GP17 GP16')
    }),
    dual({
      id: 'stm32-bluepill', name: 'STM32 Blue Pill', category: 'Dev boards',
      desc: '23 x 53 mm, 0.7" row spacing, STM32F103', color: '#1b3f7a', usb: 'micro',
      tags: S('stm32 bluepill f103'), gap: 7,
      left:  S('VBAT PC13 PC14 PC15 PA0 PA1 PA2 PA3 PA4 PA5 PA6 PA7 PB0 PB1 PB10 PB11 RST 3V3 GND GND'),
      right: S('3V3 GND 5V PB9 PB8 PB7 PB6 PB5 PB4 PB3 PA15 PA12 PA11 PA10 PA9 PA8 PB15 PB14 PB13 PB12')
    }),
    dual({
      id: 'teensy-40', name: 'Teensy 4.0', category: 'Dev boards',
      desc: '18 x 35 mm, 0.6" row spacing', color: '#123b2c', usb: 'micro',
      tags: S('teensy imxrt pjrc'), gap: 6,
      left:  S('GND D0 D1 D2 D3 D4 D5 D6 D7 D8 D9 D10 D11 D12'),
      right: S('VIN AGND 3V3 D23 D22 D21 D20 D19 D18 D17 D16 D15 D14 D13')
    }),
    dual({
      id: 'attiny85-digispark', name: 'Digispark ATtiny85', category: 'Dev boards',
      desc: '19 x 23 mm', color: '#5a1d6e', usb: 'a', gap: 4,
      tags: S('attiny85 digispark'),
      left:  S('P5 P4 P3 P2 P1 P0'),
      right: S('5V VIN GND - - -')
    }),
    inline({
      id: 'esp32-cam-hdr', name: 'ESP32-CAM (header)', category: 'Dev boards',
      desc: 'Breakout row only — body overhangs', color: '#1c1f24', w: 8, h: 12, oy: -0.5,
      tags: S('esp32cam camera'),
      names: S('5V GND IO12 IO13 IO15 IO14 IO2 IO4')
    })
  ];

  /* =================================================================
     SENSORS
     ================================================================= */
  const SENS = [
    inline({ id: 'mpu6050', name: 'MPU-6050 6-axis IMU', category: 'Sensors', color: '#1f3a5f',
      tags: S('mpu6050 imu gyro accel i2c'), w: 8, h: 6, oy: -0.5,
      names: S('VCC GND SCL SDA XDA XCL ADO INT') }),
    inline({ id: 'mpu9250', name: 'MPU-9250 9-axis IMU', category: 'Sensors', color: '#1f3a5f',
      tags: S('mpu9250 imu magnetometer'), w: 10, h: 6, oy: -0.5,
      names: S('VCC GND SCL SDA EDA ECL ADO INT NCS FSYNC') }),
    inline({ id: 'bmp280', name: 'BMP280 pressure', category: 'Sensors', color: '#2a1f4f',
      tags: S('bmp280 barometer i2c spi'), w: 6, h: 5, oy: -0.5,
      names: S('VCC GND SCL SDA CSB SDO') }),
    inline({ id: 'bme280', name: 'BME280 T/RH/P', category: 'Sensors', color: '#2a1f4f',
      tags: S('bme280 humidity i2c'), w: 4, h: 5, oy: -0.5,
      names: S('VCC GND SCL SDA') }),
    inline({ id: 'ds3231', name: 'DS3231 RTC (ZS-042)', category: 'Sensors', color: '#1a4030',
      tags: S('ds3231 rtc clock i2c'), w: 6, h: 10, oy: -0.5,
      names: S('32K SQW SCL SDA VCC GND') }),
    inline({ id: 'dht22', name: 'DHT22 / AM2302', category: 'Sensors', color: '#f0f0f0', textColor: '#111',
      tags: S('dht22 dht11 humidity'), w: 4, h: 6, oy: -0.5, shape: 'rect',
      names: S('VCC DATA NC GND') }),
    inline({ id: 'dht11-mod', name: 'DHT11 module', category: 'Sensors', color: '#1a4030',
      tags: S('dht11 humidity'), w: 3, h: 6, oy: -0.5,
      names: S('GND DATA VCC') }),
    inline({ id: 'ds18b20', name: 'DS18B20 (TO-92)', category: 'Sensors', color: '#1c1f24',
      tags: S('ds18b20 onewire temperature'), w: 3, h: 2, oy: -0.5, shape: 'to92',
      names: S('GND DQ VDD') }),
    inline({ id: 'hcsr04', name: 'HC-SR04 ultrasonic', category: 'Sensors', color: '#1f3a5f',
      tags: S('hcsr04 ultrasonic distance'), w: 4, h: 8, oy: -0.5,
      names: S('VCC TRIG ECHO GND') }),
    inline({ id: 'ky040', name: 'KY-040 rotary encoder', category: 'Sensors', color: '#1a4030',
      tags: S('ky040 encoder rotary'), w: 5, h: 8, oy: -0.5,
      names: S('GND VCC SW DT CLK') }),
    inline({ id: 'ldr-mod', name: 'LDR light module', category: 'Sensors', color: '#1a4030',
      tags: S('ldr photoresistor light'), w: 4, h: 6, oy: -0.5,
      names: S('AO DO GND VCC') }),
    inline({ id: 'hall-mod', name: 'Hall sensor module', category: 'Sensors', color: '#1a4030',
      tags: S('hall magnet a3144'), w: 3, h: 6, oy: -0.5,
      names: S('VCC GND OUT') }),
    inline({ id: 'ads1115', name: 'ADS1115 16-bit ADC', category: 'Sensors', color: '#2a1f4f',
      tags: S('ads1115 adc i2c'), w: 10, h: 6, oy: -0.5,
      names: S('VDD GND SCL SDA ADDR ALRT A0 A1 A2 A3') }),
    inline({ id: 'ina219', name: 'INA219 current sense', category: 'Sensors', color: '#2a1f4f',
      tags: S('ina219 current power i2c'), w: 6, h: 6, oy: -0.5,
      names: S('VCC GND SCL SDA VIN+ VIN-') }),
    inline({ id: 'load-cell-hx711', name: 'HX711 load cell amp', category: 'Sensors', color: '#1d5c4f',
      tags: S('hx711 loadcell strain'), w: 5, h: 8, oy: -0.5,
      names: S('VCC SCK DT GND E+') })
  ];

  /* =================================================================
     COMMS / RADIO / DISPLAY
     ================================================================= */
  const COMMS = [
    inline({ id: 'hc05', name: 'HC-05 Bluetooth', category: 'Comms & display', color: '#1f3a5f',
      tags: S('hc05 bluetooth serial'), w: 6, h: 10, oy: -0.5,
      names: S('KEY VCC GND TXD RXD STATE') }),
    inline({ id: 'hc06', name: 'HC-06 Bluetooth', category: 'Comms & display', color: '#1f3a5f',
      tags: S('hc06 bluetooth'), w: 4, h: 10, oy: -0.5,
      names: S('VCC GND TXD RXD') }),
    dual({ id: 'nrf24l01', name: 'nRF24L01+ (2x4)', category: 'Comms & display', color: '#123b2c',
      tags: S('nrf24 radio spi 2.4ghz'), gap: 1, w: 4, h: 2,
      left:  S('GND VCC CE CSN'),
      right: S('SCK MOSI MISO IRQ') }),
    inline({ id: 'lora-ra02', name: 'LoRa RA-02 SX1278', category: 'Comms & display', color: '#123b2c',
      tags: S('lora sx1278 ra02'), w: 8, h: 12, oy: -0.5,
      names: S('GND 3V3 RST DIO0 SCK MISO MOSI NSS') }),
    inline({ id: 'rfm95', name: 'RFM95 LoRa breakout', category: 'Comms & display', color: '#123b2c',
      tags: S('rfm95 lora'), w: 8, h: 10, oy: -0.5,
      names: S('GND 3V3 EN G0 SCK MISO MOSI CS') }),
    inline({ id: 'oled-i2c-4', name: 'OLED 0.96" I2C (4p)', category: 'Comms & display', color: '#101318',
      tags: S('oled ssd1306 i2c display'), w: 4, h: 11, oy: -0.5,
      names: S('GND VCC SCL SDA') }),
    inline({ id: 'oled-i2c-4b', name: 'OLED 0.96" I2C (VCC first)', category: 'Comms & display', color: '#101318',
      tags: S('oled ssd1306 i2c'), w: 4, h: 11, oy: -0.5,
      names: S('VCC GND SCL SDA') }),
    inline({ id: 'oled-spi-7', name: 'OLED 1.3" SPI (7p)', category: 'Comms & display', color: '#101318',
      tags: S('oled sh1106 spi'), w: 7, h: 13, oy: -0.5,
      names: S('GND VCC CLK MOSI RES DC CS') }),
    inline({ id: 'lcd1602-i2c', name: 'LCD1602 + I2C backpack', category: 'Comms & display', color: '#123b2c',
      tags: S('lcd1602 hd44780 pcf8574'), w: 4, h: 12, oy: -0.5,
      names: S('GND VCC SDA SCL') }),
    inline({ id: 'lcd1602-hdr', name: 'LCD1602 parallel (16p)', category: 'Comms & display', color: '#123b2c',
      tags: S('lcd1602 hd44780'), w: 16, h: 14, oy: -0.5,
      names: S('VSS VDD VO RS RW E D0 D1 D2 D3 D4 D5 D6 D7 A K') }),
    inline({ id: 'tft-ili9341', name: '2.4" TFT ILI9341 SPI', category: 'Comms & display', color: '#101318',
      tags: S('tft ili9341 spi display'), w: 14, h: 22, oy: -0.5,
      names: S('VCC GND CS RESET DC SDI SCK LED SDO T_CLK T_CS T_DIN T_DO T_IRQ') }),
    inline({ id: 'max7219-8x8', name: 'MAX7219 8x8 matrix', category: 'Comms & display', color: '#1a4030',
      tags: S('max7219 matrix led'), w: 5, h: 14, oy: -0.5,
      names: S('VCC GND DIN CS CLK') }),
    inline({ id: 'tm1637', name: 'TM1637 4-digit 7-seg', category: 'Comms & display', color: '#1a4030',
      tags: S('tm1637 sevensegment'), w: 4, h: 8, oy: -0.5,
      names: S('CLK DIO VCC GND') }),
    inline({ id: 'sdcard-mod', name: 'microSD card module', category: 'Comms & display', color: '#1f3a5f',
      tags: S('sd microsd spi storage'), w: 6, h: 9, oy: -0.5,
      names: S('GND VCC MISO MOSI SCK CS') }),
    inline({ id: 'rc522', name: 'RC522 RFID reader', category: 'Comms & display', color: '#123b2c',
      tags: S('rc522 rfid mfrc522 spi'), w: 8, h: 15, oy: -0.5,
      names: S('SDA SCK MOSI MISO IRQ GND RST 3V3') }),
    dual({ id: 'esp01', name: 'ESP-01 / ESP-01S (2x4)', category: 'Comms & display', color: '#1d5c4f',
      tags: S('esp8266 esp01'), gap: 1, w: 4, h: 2,
      left:  S('GND GPIO2 GPIO0 RXD'),
      right: S('TXD CH_PD RST VCC') })
  ];

  /* =================================================================
     POWER
     ================================================================= */
  const POWER = [
    inline({ id: 'tp4056', name: 'TP4056 Li-ion charger', category: 'Power', color: '#1a4030',
      tags: S('tp4056 charger lipo battery'), w: 6, h: 10, oy: -0.5,
      names: S('IN+ IN- BAT+ BAT- OUT+ OUT-') }),
    inline({ id: 'mp1584', name: 'MP1584EN buck (mini)', category: 'Power', color: '#1a4030',
      tags: S('mp1584 buck stepdown'), w: 4, h: 6, oy: -0.5,
      names: S('IN+ IN- OUT+ OUT-') }),
    inline({ id: 'lm2596', name: 'LM2596 buck module', category: 'Power', color: '#1a4030',
      tags: S('lm2596 buck stepdown'), w: 8, h: 17, oy: -0.5,
      names: S('IN+ IN- OUT+ OUT-') }),
    inline({ id: 'ams1117-mod', name: 'AMS1117 3V3 module', category: 'Power', color: '#1a4030',
      tags: S('ams1117 ldo 3v3'), w: 3, h: 5, oy: -0.5,
      names: S('VIN GND 3V3') }),
    inline({ id: 'xl6009', name: 'XL6009 boost module', category: 'Power', color: '#1a4030',
      tags: S('xl6009 boost stepup'), w: 8, h: 17, oy: -0.5,
      names: S('IN+ IN- OUT+ OUT-') }),
    inline({ id: 'reg-7805', name: '7805 regulator TO-220', category: 'Power', color: '#1c1f24',
      tags: S('7805 lm7805 linear regulator to220'), w: 3, h: 4, oy: -0.5, shape: 'to220',
      names: S('IN GND OUT') }),
    inline({ id: 'reg-1117-to220', name: 'LD1117 / LM317 TO-220', category: 'Power', color: '#1c1f24',
      tags: S('ld1117 lm317 to220'), w: 3, h: 4, oy: -0.5, shape: 'to220',
      names: S('ADJ OUT IN') }),
    inline({ id: 'buck-usb', name: 'USB-C PD trigger', category: 'Power', color: '#1a4030',
      tags: S('usbc pd trigger power'), w: 4, h: 9, oy: -0.5,
      names: S('VBUS GND CC1 CC2') }),
    inline({ id: 'relay-1ch', name: 'Relay module 1-ch', category: 'Power', color: '#1a4030',
      tags: S('relay 5v srd'), w: 3, h: 12, oy: -0.5,
      names: S('VCC GND IN') }),
    inline({ id: 'relay-2ch', name: 'Relay module 2-ch', category: 'Power', color: '#1a4030',
      tags: S('relay 2channel'), w: 4, h: 20, oy: -0.5,
      names: S('VCC GND IN1 IN2') }),
    inline({ id: 'l298n', name: 'L298N motor driver', category: 'Power', color: '#1a4030',
      tags: S('l298n motor hbridge'), w: 6, h: 16, oy: -0.5,
      names: S('ENA IN1 IN2 IN3 IN4 ENB') }),
    inline({ id: 'drv8825', name: 'DRV8825 / A4988 driver', category: 'Power', color: '#1a4030',
      tags: S('drv8825 a4988 stepper'), w: 8, h: 6, oy: -0.5,
      names: S('EN M0 M1 M2 RST SLP STEP DIR') }),
    inline({ id: 'uln2003-mod', name: 'ULN2003 stepper board', category: 'Power', color: '#1a4030',
      tags: S('uln2003 stepper 28byj'), w: 4, h: 12, oy: -0.5,
      names: S('IN1 IN2 IN3 IN4') }),
    inline({ id: 'mosfet-mod', name: 'IRF520 MOSFET module', category: 'Power', color: '#1a4030',
      tags: S('irf520 mosfet switch'), w: 3, h: 12, oy: -0.5,
      names: S('SIG VCC GND') })
  ];

  /* =================================================================
     ICs & SOCKETS
     ================================================================= */
  const ICS = [
    dip({ id: 'dip8', name: 'DIP-8 socket', category: 'ICs & sockets', count: 8, wide: 3,
      refPrefix: 'U', tags: S('dip8 socket'), }),
    dip({ id: 'dip14', name: 'DIP-14 socket', category: 'ICs & sockets', count: 14, wide: 3, tags: S('dip14 socket') }),
    dip({ id: 'dip16', name: 'DIP-16 socket', category: 'ICs & sockets', count: 16, wide: 3, tags: S('dip16 socket') }),
    dip({ id: 'dip18', name: 'DIP-18 socket', category: 'ICs & sockets', count: 18, wide: 3, tags: S('dip18') }),
    dip({ id: 'dip20', name: 'DIP-20 socket', category: 'ICs & sockets', count: 20, wide: 3, tags: S('dip20') }),
    dip({ id: 'dip24w', name: 'DIP-24 wide socket', category: 'ICs & sockets', count: 24, wide: 6, tags: S('dip24') }),
    dip({ id: 'dip28w', name: 'DIP-28 wide socket', category: 'ICs & sockets', count: 28, wide: 6, tags: S('dip28') }),
    dip({ id: 'dip40w', name: 'DIP-40 wide socket', category: 'ICs & sockets', count: 40, wide: 6, tags: S('dip40') }),

    dip({ id: 'ne555', name: 'NE555 timer', category: 'ICs & sockets', count: 8, wide: 3,
      tags: S('555 ne555 timer'), names: S('GND TRIG OUT RESET CTRL THRES DISCH VCC') }),
    dip({ id: 'lm358', name: 'LM358 dual op-amp', category: 'ICs & sockets', count: 8, wide: 3,
      tags: S('lm358 opamp'), names: S('OUT1 IN1- IN1+ V- IN2+ IN2- OUT2 V+') }),
    dip({ id: 'tl072', name: 'TL072 dual op-amp', category: 'ICs & sockets', count: 8, wide: 3,
      tags: S('tl072 opamp audio'), names: S('OUT1 IN1- IN1+ V- IN2+ IN2- OUT2 V+') }),
    dip({ id: 'lm393', name: 'LM393 comparator', category: 'ICs & sockets', count: 8, wide: 3,
      tags: S('lm393 comparator'), names: S('OUT1 IN1- IN1+ GND IN2+ IN2- OUT2 VCC') }),
    dip({ id: '74hc595', name: '74HC595 shift register', category: 'ICs & sockets', count: 16, wide: 3,
      tags: S('74hc595 shiftregister'), names: S('Q1 Q2 Q3 Q4 Q5 Q6 Q7 GND Q7S MR SHCP STCP OE DS Q0 VCC') }),
    dip({ id: '74hc165', name: '74HC165 shift register', category: 'ICs & sockets', count: 16, wide: 3,
      tags: S('74hc165'), names: S('PL CP D4 D5 D6 D7 Q7N GND Q7 DS D0 D1 D2 D3 CE VCC') }),
    dip({ id: '74hc14', name: '74HC14 Schmitt inverter', category: 'ICs & sockets', count: 14, wide: 3,
      tags: S('74hc14 inverter'), names: S('1A 1Y 2A 2Y 3A 3Y GND 4Y 4A 5Y 5A 6Y 6A VCC') }),
    dip({ id: 'atmega328p', name: 'ATmega328P DIP-28', category: 'ICs & sockets', count: 28, wide: 6,
      tags: S('atmega328 avr arduino'),
      names: S('RESET RXD TXD D2 D3 D4 VCC GND XTAL1 XTAL2 D5 D6 D7 D8 D9 D10 D11 D12 D13 AVCC AREF GND A0 A1 A2 A3 A4 A5') }),
    dip({ id: 'attiny85', name: 'ATtiny85 DIP-8', category: 'ICs & sockets', count: 8, wide: 3,
      tags: S('attiny85 avr'), names: S('RESET PB3 PB4 GND PB0 PB1 PB2 VCC') }),
    dip({ id: 'mcp23017', name: 'MCP23017 I/O expander', category: 'ICs & sockets', count: 28, wide: 6,
      tags: S('mcp23017 i2c expander'),
      names: S('GPB0 GPB1 GPB2 GPB3 GPB4 GPB5 GPB6 GPB7 VDD VSS NC SCL SDA NC A0 A1 A2 RESET INTB INTA GPA0 GPA1 GPA2 GPA3 GPA4 GPA5 GPA6 GPA7') }),
    dip({ id: 'pcf8574', name: 'PCF8574 I/O expander', category: 'ICs & sockets', count: 16, wide: 3,
      tags: S('pcf8574 i2c'), names: S('A0 A1 A2 P0 P1 P2 P3 VSS P4 P5 P6 P7 INT SCL SDA VDD') }),
    dip({ id: 'opto-4n35', name: '4N35 optocoupler DIP-6', category: 'ICs & sockets', count: 6, wide: 3,
      tags: S('4n35 optocoupler'), names: S('A K NC E C B') }),
    dip({ id: 'ln-h11l1', name: 'MCT2E optocoupler', category: 'ICs & sockets', count: 6, wide: 3,
      tags: S('mct2e opto'), names: S('A K NC E C B') })
  ];

  /* =================================================================
     PASSIVES & DISCRETES
     ================================================================= */
  const PASS = [
    axial({ id: 'r-axial-3', name: 'Resistor 1/4W (3 holes)', category: 'Passives', color: '#c9a76a',
      textColor: '#20160a', refPrefix: 'R', shape: 'axial', defaultValue: '10k',
      tags: S('resistor axial'), span: 3, a: '1', b: '2' }),
    axial({ id: 'r-axial-4', name: 'Resistor 1/4W (4 holes)', category: 'Passives', color: '#c9a76a',
      textColor: '#20160a', refPrefix: 'R', shape: 'axial', defaultValue: '10k',
      tags: S('resistor axial'), span: 4 }),
    axial({ id: 'r-axial-v', name: 'Resistor, standing (1 hole)', category: 'Passives', color: '#c9a76a',
      textColor: '#20160a', refPrefix: 'R', shape: 'axial', defaultValue: '10k',
      tags: S('resistor vertical'), span: 1 }),
    axial({ id: 'd-axial-3', name: 'Diode 1N4148 (3 holes)', category: 'Passives', color: '#20242c',
      refPrefix: 'D', shape: 'axial', defaultValue: '1N4148', notch: 'cathode',
      tags: S('diode 1n4148 1n4007'), span: 3, a: 'A', b: 'K' }),
    axial({ id: 'd-axial-4', name: 'Diode 1N4007 (4 holes)', category: 'Passives', color: '#20242c',
      refPrefix: 'D', shape: 'axial', defaultValue: '1N4007', notch: 'cathode',
      tags: S('diode rectifier'), span: 4, a: 'A', b: 'K' }),
    axial({ id: 'led-3mm', name: 'LED 3 mm', category: 'Passives', color: '#e04b4b',
      refPrefix: 'D', shape: 'led', defaultValue: 'red',
      tags: S('led 3mm indicator'), span: 1, a: 'A', b: 'K' }),
    axial({ id: 'led-5mm', name: 'LED 5 mm', category: 'Passives', color: '#e04b4b',
      refPrefix: 'D', shape: 'led', defaultValue: 'red',
      tags: S('led 5mm'), span: 1, a: 'A', b: 'K', w: 2, h: 2, oy: -1 }),
    axial({ id: 'cap-cer-100n', name: 'Ceramic cap 0.1" (1 hole)', category: 'Passives', color: '#3f6bb0',
      refPrefix: 'C', shape: 'disc', defaultValue: '100n',
      tags: S('capacitor ceramic mlcc'), span: 1, a: '1', b: '2' }),
    axial({ id: 'cap-cer-2', name: 'Ceramic cap 0.2" (2 holes)', category: 'Passives', color: '#3f6bb0',
      refPrefix: 'C', shape: 'disc', defaultValue: '1u',
      tags: S('capacitor ceramic'), span: 2 }),
    axial({ id: 'cap-elec-2', name: 'Electrolytic 5 mm (2 holes)', category: 'Passives', color: '#1c2b47',
      refPrefix: 'C', shape: 'radial', defaultValue: '100u', notch: 'minus',
      tags: S('capacitor electrolytic'), span: 2, a: '+', b: '-', w: 3, h: 3, ox: -1, oy: -1 }),
    axial({ id: 'cap-elec-3', name: 'Electrolytic 8 mm (3 holes)', category: 'Passives', color: '#1c2b47',
      refPrefix: 'C', shape: 'radial', defaultValue: '470u', notch: 'minus',
      tags: S('capacitor electrolytic'), span: 3, a: '+', b: '-', w: 4, h: 4, ox: -0.5, oy: -1.5 }),
    axial({ id: 'inductor-3', name: 'Inductor (3 holes)', category: 'Passives', color: '#4a3a2a',
      refPrefix: 'L', shape: 'axial', defaultValue: '100u', tags: S('inductor choke'), span: 3 }),
    axial({ id: 'xtal-hc49', name: 'Crystal HC-49 (2 holes)', category: 'Passives', color: '#8e97a3',
      textColor: '#101319', refPrefix: 'Y', shape: 'rect', defaultValue: '16MHz',
      tags: S('crystal quartz oscillator'), span: 2, w: 3, h: 2, ox: -0.5, oy: -0.5 }),
    inline({ id: 'to92', name: 'Transistor TO-92', category: 'Passives', color: '#1c1f24',
      refPrefix: 'Q', shape: 'to92', defaultValue: '2N3904',
      tags: S('transistor to92 bc547 2n3904'), w: 3, h: 2, oy: -0.5, names: S('E B C') }),
    inline({ id: 'to220-3', name: 'TO-220 3-pin', category: 'Passives', color: '#1c1f24',
      refPrefix: 'Q', shape: 'to220', defaultValue: 'IRF540',
      tags: S('mosfet to220 transistor'), w: 3, h: 4, oy: -0.5, names: S('G D S') }),
    inline({ id: 'trimpot-3', name: 'Trimpot 6 mm', category: 'Passives', color: '#1c4a6e',
      refPrefix: 'RV', shape: 'rect', defaultValue: '10k',
      tags: S('trimpot potentiometer'), w: 3, h: 3, oy: -0.5, names: S('1 2 3') }),
    inline({ id: 'pot-9mm', name: 'Potentiometer 9 mm', category: 'Passives', color: '#1c4a6e',
      refPrefix: 'RV', shape: 'rounded', defaultValue: '10k',
      tags: S('potentiometer pot'), w: 5, h: 5, oy: -0.5, names: S('1 2 3') }),
    inline({ id: 'thermistor', name: 'Thermistor NTC', category: 'Passives', color: '#2a2f39',
      refPrefix: 'TH', shape: 'disc', defaultValue: '10k',
      tags: S('ntc thermistor'), w: 2, h: 2, oy: -0.5, names: S('1 2') })
  ];

  /* =================================================================
     CONNECTORS
     ================================================================= */
  const CONN = [];
  [2, 3, 4, 5, 6, 8, 10, 12, 16, 20].forEach(function (n) {
    CONN.push(inline({
      id: 'hdr-1x' + n, name: 'Pin header 1x' + n, category: 'Connectors',
      color: '#22262e', refPrefix: 'J', shape: 'header', tags: S('header pin 1x' + n),
      names: Array.from({ length: n }, (_, i) => String(i + 1))
    }));
  });
  [3, 4, 5, 8, 10, 13, 20].forEach(function (n) {
    const names = Array.from({ length: n }, (_, i) => String(i * 2 + 1));
    const names2 = Array.from({ length: n }, (_, i) => String(i * 2 + 2));
    CONN.push(dual({
      id: 'hdr-2x' + n, name: 'Pin header 2x' + n, category: 'Connectors',
      color: '#22262e', refPrefix: 'J', shape: 'header', tags: S('header idc 2x' + n),
      gap: 1, left: names, right: names2
    }));
  });
  [2, 3, 4].forEach(function (n) {
    CONN.push(inline({
      id: 'screw-' + n, name: 'Screw terminal ' + n + '-way (5 mm)', category: 'Connectors',
      color: '#1d5c1d', refPrefix: 'J', shape: 'screw', tags: S('screwterminal 5mm'),
      w: n * 2, h: 4, ox: -0.5, oy: -0.5,
      names: Array.from({ length: n }, (_, i) => String(i + 1))
    }));
    // Wide spacing (5 mm pitch = 2 holes) needs custom pin spread:
    const p = CONN[CONN.length - 1];
    p.pins.forEach(function (pn, i) { pn.c = i * 2; });
  });
  [2, 3, 4, 5, 6].forEach(function (n) {
    CONN.push(inline({
      id: 'jst-xh' + n, name: 'JST-XH ' + n + '-pin', category: 'Connectors',
      color: '#f0f0f0', textColor: '#111', refPrefix: 'J', shape: 'rect',
      tags: S('jst xh connector'), w: n + 1, h: 3, oy: -0.5,
      names: Array.from({ length: n }, (_, i) => String(i + 1))
    }));
  });
  CONN.push(inline({ id: 'dc-barrel', name: 'DC barrel jack 5.5 mm', category: 'Connectors',
    color: '#1c1f24', refPrefix: 'J', shape: 'rect', tags: S('dcjack barrel power'),
    w: 6, h: 5, oy: -0.5, names: S('V+ GND SW') }));
  CONN.push(inline({ id: 'usb-b-micro-bo', name: 'micro-USB breakout', category: 'Connectors',
    color: '#1a4030', refPrefix: 'J', tags: S('usb micro breakout'),
    w: 5, h: 6, oy: -0.5, names: S('VBUS D- D+ ID GND') }));
  CONN.push(inline({ id: 'usb-c-bo', name: 'USB-C breakout (6p)', category: 'Connectors',
    color: '#1a4030', refPrefix: 'J', tags: S('usbc breakout'),
    w: 6, h: 6, oy: -0.5, names: S('VBUS GND D+ D- CC1 CC2') }));
  CONN.push(inline({ id: 'servo-hdr', name: 'Servo header 1x3', category: 'Connectors',
    color: '#22262e', refPrefix: 'J', shape: 'header', tags: S('servo header'),
    w: 3, h: 1, names: S('GND V+ SIG') }));
  CONN.push(inline({ id: 'jst-ph2', name: 'JST-PH 2-pin (battery)', category: 'Connectors',
    color: '#f0f0f0', textColor: '#111', refPrefix: 'J', shape: 'rect',
    tags: S('jst ph battery'), w: 3, h: 3, oy: -0.5, names: S('+ -') }));

  /* =================================================================
     ELECTROMECHANICAL
     ================================================================= */
  const MECH = [
    def({ id: 'tact-6mm', name: 'Tactile switch 6 mm', category: 'Electromechanical',
      color: '#1c1f24', refPrefix: 'SW', shape: 'tact', tags: S('button tactile switch') },
      { w: 3, h: 3, ox: -0.5, oy: -0.5,
        pins: [pin(1, '1a', 0, 0), pin(2, '2a', 2, 0), pin(3, '1b', 0, 2), pin(4, '2b', 2, 2)] }),
    def({ id: 'tact-2p', name: 'Tactile switch 2-pin', category: 'Electromechanical',
      color: '#1c1f24', refPrefix: 'SW', shape: 'tact', tags: S('button switch') },
      { w: 2, h: 2, ox: -0.5, oy: -0.5, pins: [pin(1, '1', 0, 0), pin(2, '2', 0, 1)] }),
    inline({ id: 'slide-spdt', name: 'Slide switch SPDT', category: 'Electromechanical',
      color: '#8e97a3', textColor: '#101319', refPrefix: 'SW', shape: 'rect',
      tags: S('slide switch spdt'), w: 4, h: 3, oy: -0.5, names: S('1 COM 3') }),
    inline({ id: 'dip-sw4', name: 'DIP switch 4-way', category: 'Electromechanical',
      color: '#e04b4b', refPrefix: 'SW', shape: 'dip', tags: S('dipswitch'),
      w: 4, h: 4, oy: -0.5, names: S('1 2 3 4') }),
    inline({ id: 'buzzer-active', name: 'Buzzer, active 12 mm', category: 'Electromechanical',
      color: '#101318', refPrefix: 'BZ', shape: 'radial', tags: S('buzzer piezo'),
      w: 5, h: 5, ox: -0.5, oy: -2, names: S('+ -') }),
    inline({ id: 'fan-hdr', name: 'Fan header 1x2', category: 'Electromechanical',
      color: '#22262e', refPrefix: 'J', shape: 'header', tags: S('fan'), w: 2, h: 1, names: S('V+ GND') }),
    def({ id: 'standoff-m3', name: 'M3 standoff / mount hole', category: 'Electromechanical',
      color: '#5b6472', refPrefix: 'MH', shape: 'circle', through: false, tags: S('mount hole standoff m3') },
      { w: 3, h: 3, ox: -1, oy: -1, pins: [] })
  ];

  /* =================================================================
     Register
     ================================================================= */
  const ALL = [].concat(DEV, SENS, COMMS, POWER, ICS, PASS, CONN, MECH);
  window.PB = window.PB || {};
  window.PB.BUILTIN_PARTS = ALL;
})();
