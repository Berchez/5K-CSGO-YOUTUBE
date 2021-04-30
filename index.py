from selenium import webdriver


InicioDeRound = 0
todosMatadores = []
todosMatadoresFinal = []
i=1
plantouBomba = ''
matador = ''
tScore = 0
ctScore = 0

#/html/body/div[2]/div/div[2]/div[1]/div[2]/div[6]/div/div[4]/div/div[1]/div/div[1]/div/div

#/html/body/div[2]/div/div[2]/div[1]/div[2]/div[6]/div/div[4]/div/div[1]/div/div[1]/div/div/span/span[1]

#/html/body/div[2]/div/div[2]/div[1]/div[2]/div[6]/div/div[4]/div/div[1]/div/div[12]/div/div/span/span[1]


#/html/body/div[2]/div/div[2]/div[1]/div[2]/div[4]/div/div[1]/div[3]/div/div[2]/div[1]/a[1]
#/html/body/div[2]/div/div[2]/div[1]/div[2]/div[4]/div/div[1]/div[3]/div/div[1]/div[1]/a[1]


from time import sleep

options = webdriver.ChromeOptions() 
options.add_argument("user-data-dir=/home/berchez/.config/google-chrome/CSGO")
options.add_argument('--profile-directory=Profile 1')
options.add_argument("start-maximized")
driver = webdriver.Chrome("/usr/local/bin/chromedriver", chrome_options=options)

driver.get('https://www.hltv.org/matches?predefinedFilter=top_tier')

sleep(3)
partidas = driver.find_elements_by_class_name("liveMatch")
numPartidas = len(partidas)
sleep(3)

for x in range(0, numPartidas):
    partidas[x].click()
    try:
        linkLive = driver.find_elements_by_class_name('stream-box-embed')
        sleep(2)
        linkLive[0].click()
    except:
        driver.get('https://www.hltv.org/matches?predefinedFilter=top_tier')
        print("Nao tem BR streamando")
        sleep(5)
        partidas = driver.find_elements_by_class_name("liveMatch")
    else:
        ctScore = int(driver.find_element_by_class_name('ctScore').text)
        tScore = int(driver.find_element_by_class_name('tScore').text)
        while (ctScore != 16 | tScore !=16):
            while (InicioDeRound == 0):
                try:
                    matador = driver.find_element_by_xpath(f'/html/body/div[2]/div/div[2]/div[1]/div[2]/div[6]/div/div[4]/div/div[1]/div/div[{i}]/div/div/span/span[1]').text                    
                except:
                    try:
                        plantouBomba = driver.find_element_by_xpath(f'/html/body/div[2]/div/div[2]/div[1]/div[2]/div[6]/div/div[4]/div/div[1]/div/div[1]/div/div/span[1]')
                        i += 1
                    except:
                        print("Deu Errado")
                        i=1
                else:
                    todosMatadores.append(matador)
                    if matador == 'T':
                        todosMatadores.pop()
                        InicioDeRound = 1
                        ctScore = int(driver.find_element_by_class_name('ctScore').text)
                        tScore = int(driver.find_element_by_class_name('tScore').text)
                        print(f'Todos: {todosMatadores}')
                        print(f'48: Placar {tScore} X {ctScore}')
                        todosMatadores = []
                        i = 0
                        matador = ''
                    if matador == 'CT':
                        todosMatadores.pop()

                        InicioDeRound = 1
                        ctScore = int(driver.find_element_by_class_name('ctScore').text)
                        tScore = int(driver.find_element_by_class_name('tScore').text)
                        print(f'Todos: {todosMatadores}')
                        print(f'48: Placar {tScore} X {ctScore}')
                        todosMatadores = []
                        i=0
                        matador = ''
                    i +=1
                    sleep(0.5)
            i = 1
            InicioDeRound = 0
            sleep(0.05)
    


#/html/body/div[2]/div/div[2]/div[1]/div[2]/div[6]/div/div[4]/div/div[1]/div/div[2]