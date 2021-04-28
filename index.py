from selenium import webdriver
from time import sleep

options = webdriver.ChromeOptions() 
options.add_argument("user-data-dir=/home/berchez/.config/google-chrome/CSGO")
options.add_argument('--profile-directory=Profile 1')
options.add_argument("start-maximized")
driver = webdriver.Chrome("/usr/local/bin/chromedriver", chrome_options=options)

driver.get('https://www.hltv.org/matches?predefinedFilter=top_tier')

sleep(3)
partidas = driver.find_elements_by_class_name("liveMatch")
sleep(3)

for x in partidas:
    x.click()
    linkLive = driver.find_elements_by_xpath('//*[@title="Brazil"]')
