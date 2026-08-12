本项目意在完成一整套配置流程，用于配置我的个人主机的基本环境。
需要适配ubuntu和红帽系的系统，首先提供一个init.sh脚本，安装基本的pi-agent环境。（使用curl -fsSL https://pi.dev/install.sh | sh)
然后继续配置一些基本的我需要的工具
包括vim wireguard tmux

然后将在本项目内的skill直接使用原名安装给pi-agent

以上是初始化层的功能点，完成之后，优化现有的skill结构，清理掉现在没意义的同步功能，直接转为基于skill的，手动执行的模式。

